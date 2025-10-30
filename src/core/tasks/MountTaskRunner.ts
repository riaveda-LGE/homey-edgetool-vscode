// === src/core/tasks/MountTaskRunner.ts ===

import { getLogger } from '../logging/extension-logger.js';
import { WorkflowEngine } from './workflow/workflowEngine.js';
import { HostStateGuard } from './guards/HostStateGuard.js';
import { connectionManager } from '../connection/ConnectionManager.js';
import { ServiceFilePatcher } from '../service/ServiceFilePatcher.js';
import { resolveHomeyUnit } from '../service/serviceDiscovery.js';

export type Mode = 'pro' | 'core' | 'sdk' | 'bridge';

export class MountTaskRunner {
  private log = getLogger('MountRunner');
  private guard = new HostStateGuard();

  constructor(private modes: Mode[]) {}

  async run() {
    const unit = await resolveHomeyUnit();
    const svc = new ServiceFilePatcher(unit);
    const steps: any[] = [];

    steps.push({
      name: 'INIT',
      run: async () => {
        await connectionManager.run(`sh -lc 'id >/dev/null'`);
        return 'ok';
      },
    });

    steps.push({
      name: 'READ_SERVICE_FILE',
      run: async (ctx: any) => {
        const path = await svc.resolveServicePath();
        ctx.bag.svcPath = path;
        ctx.bag.existed = {} as Record<string, boolean>;
        ctx.bag.insertLines = buildLines(this.modes);
        for (const rx of volumeRegexAll(this.modes)) {
          ctx.bag.existed[rx] = await svc.contains(path, rx);
        }
        ctx.bag.hashBefore = await svc.computeHash(path);
        return 'ok';
      },
    });

    steps.push({
      name: 'DRY_RUN_DIFF',
      run: async (ctx: any) => {
        const toInsert: string[] = [];
        for (const ln of ctx.bag.insertLines as string[]) {
          const rx = lineToRegex(ln);
          if (!ctx.bag.existed[rx]) toInsert.push(ln);
        }
        ctx.bag.dryRun = toInsert;
        this.log.info(`[mount.dryrun] will insert ${toInsert.length} line(s)`);
        toInsert.forEach((l: string) => this.log.info(' + ' + l));
        return 'ok';
      },
    });

    steps.push({
      name: 'BACKUP',
      run: async (ctx: any) => {
        ctx.bag.backup = await svc.backup(ctx.bag.svcPath);
        return 'ok';
      },
    });

    steps.push({
      name: 'APPLY_PATCH',
      run: async (ctx: any) => {
        await this.guard.ensureFsRemountRW('/');
        const path: string = ctx.bag.svcPath;
        const toInsert: string[] = ctx.bag.dryRun as string[];
        for (const ln of toInsert) {
          await svc.insertAfterExecStart(path, ln);
        }
        // 변경 반영 대기(최대 8s)
        await this.guard.waitForServiceFileChange(path, 8000, 500);
        return 'ok';
      },
    });

    steps.push({ name: 'DAEMON_RELOAD', run: async () => { await svc.daemonReload(); return 'ok'; } });

    steps.push({
      name: 'RESTART_SERVICE',
      run: async () => {
        await svc.restart();
        const ok = await this.guard.waitForUnitActive(unit, 30_000, 1500);
        return ok ? 'ok' : 'fail';
      },
    });

    steps.push({
      name: 'POST_VERIFY',
      run: async (ctx: any) => {
        const path = ctx.bag.svcPath as string;
        const want: string[] = ctx.bag.insertLines as string[];
        for (const ln of want) {
          const ok = await svc.contains(path, lineToRegex(ln));
          if (!ok) return 'fail';
        }
        return 'ok';
      },
    });

    steps.push({ name: 'CLEANUP', run: async () => 'ok' });

    const wf = new WorkflowEngine(steps);
    await wf.runAll(`mount-${Date.now()}`);
  }
}

export function buildLines(modes: Mode[]): string[] {
  const out: string[] = [];
  if (modes.includes('pro')) out.push(`--volume="homey-app:/app:rw"`);
  if (modes.includes('core')) out.push(`--volume="homey-node:/node:rw"`);
  if (modes.includes('sdk')) out.push(`--volume="homey-node:/node/@athombv/homey-apps-sdk-v3:rw"`);
  if (modes.includes('bridge')) out.push(`--volume="homey-node:/node/@athombv/homey-bridge:rw"`);
  return out;
}

export function lineToRegex(line: string): string {
  const body = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^\\s*${body}\\s*\\\\?\\s*$`;
}

export function volumeRegexAll(modes: Mode[]): string[] {
  return buildLines(modes).map(lineToRegex);
}