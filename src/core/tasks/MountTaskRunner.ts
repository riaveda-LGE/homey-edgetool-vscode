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

  // ✅ 정책 변경: 기본적으로 homey-app(pro) + homey-node(core) 둘 다 삽입
  constructor(private modes: Mode[] = ['pro', 'core']) {}

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
        this.log.info(`[mount] unit=${unit} file=${path}`);
        ctx.bag.svcPath = path;
        ctx.bag.workPath = await svc.stageToWorkCopy(path);
        // ✅ 토큰 존재만 확인 (중간 문구 기준)
        ctx.bag.tokens = markerTokensForModes(this.modes); // → ['homey-app','homey-node']
        ctx.bag.existed = {} as Record<string, boolean>;
        for (const t of ctx.bag.tokens as string[]) {
          ctx.bag.existed[t] = await svc.contains(ctx.bag.workPath, tokenToRegex(t));
        }
        ctx.bag.insertLines = buildLines(this.modes); // 두 줄 생성
        ctx.bag.hashBefore = await svc.computeHash(path);
        return 'ok';
      },
    });

    steps.push({
      name: 'DRY_RUN_DIFF',
      run: async (ctx: any) => {
        // 존재하지 않는 것만 삽입 대상으로 미리보기
        const toInsert: string[] = [];
        const tokens: string[] = ctx.bag.tokens as string[];
        const needApp = tokens.includes('homey-app') && !ctx.bag.existed['homey-app'];
        const needNode = tokens.includes('homey-node') && !ctx.bag.existed['homey-node'];
        for (const ln of ctx.bag.insertLines as string[]) {
          if (ln.includes('homey-app') && needApp) toInsert.push(ln);
          if (ln.includes('homey-node') && needNode) toInsert.push(ln);
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
        await this.guard.ensureFsRemountRW('/');
        ctx.bag.backup = await svc.backup(ctx.bag.svcPath);
        return 'ok';
      },
    });

    steps.push({
      name: 'APPLY_PATCH',
      run: async (ctx: any) => {
        await this.guard.ensureFsRemountRW('/');
        const path: string = ctx.bag.svcPath;
        const work: string = ctx.bag.workPath;
        const toInsert: string[] = ctx.bag.dryRun as string[];
        for (const ln of toInsert) {
          await svc.insertAfterExecStart(work, ln);
        }
        await svc.replaceOriginalWith(path, work);
        const changed = await this.guard.waitForServiceFileChange(path, 8000, 500, ctx.bag.hashBefore);
        if (!changed) {
          this.log.error(`[mount] service file did not change: ${path}`);
          //throw new Error('patch not applied (no file change detected)');
        }
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
        const tokens: string[] = ctx.bag.tokens as string[];
        for (const t of tokens) {
          const ok = await svc.contains(path, tokenToRegex(t));
          if (!ok) {
            this.log.error(`[mount.verify] missing token: ${t}`);
            throw new Error('verification failed (token not found)');
          }
        }
        return 'ok';
      },
    });

    steps.push({ name: 'CLEANUP', run: async () => { await svc.cleanupWorkdir(); return 'ok'; } });

    const wf = new WorkflowEngine(steps);
    await wf.runAll(`mount-${Date.now()}`);
  }
}

// ⬇️ 삽입 라인: 정책에 따라 2줄 고정
export function buildLines(modes: Mode[]): string[] {
  const out: string[] = [];
  // homey-app 매핑
  out.push(`--volume="homey-app:/app:rw"`);
  // homey-node 매핑 (core/sdk/bridge 공통)
  out.push(`--volume="homey-node:/node_modules:rw"`);
  return out;
}

export function lineToRegex(line: string): string {
  const body = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const WS = String.raw`[[:space:]]`;
  return String.raw`^${WS}*${body}${WS}*(\\\\)?${WS}*$`;
}

// ✅ 토큰은 고정 2개
export function markerTokensForModes(_: Mode[]): string[] {
  return ['homey-app', 'homey-node'];
}

export function tokenToRegex(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}