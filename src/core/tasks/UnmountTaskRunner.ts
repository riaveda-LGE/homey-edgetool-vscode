// === src/core/tasks/UnmountTaskRunner.ts ===

import { getLogger } from '../logging/extension-logger.js';
import { WorkflowEngine } from './workflow/workflowEngine.js';
import { HostStateGuard } from './guards/HostStateGuard.js';
import { connectionManager } from '../connection/ConnectionManager.js';
import { ServiceFilePatcher } from '../service/ServiceFilePatcher.js';
import { resolveHomeyUnit } from '../service/serviceDiscovery.js';

export class UnmountTaskRunner {
  private log = getLogger('UnmountRunner');
  private guard = new HostStateGuard();
  constructor(private deletePatterns: string[] = DEFAULT_PATTERNS) {}

  async run() {
    const unit = await resolveHomeyUnit();
    const svc = new ServiceFilePatcher(unit);
    const steps: any[] = [];

    steps.push({ name: 'INIT', run: async () => { await connectionManager.run(`sh -lc 'id >/dev/null'`); return 'ok'; } });

    steps.push({
      name: 'READ_SERVICE_FILE',
      run: async (ctx: any) => {
        ctx.bag.svcPath = await svc.resolveServicePath();
        ctx.bag.hashBefore = await svc.computeHash(ctx.bag.svcPath);
        return 'ok';
      },
    });

    steps.push({
      name: 'DRY_RUN_DIFF',
      run: async (ctx: any) => {
        // 미리 어떤 라인이 지워질지 미리보기(정규식 매칭 라인 출력)
        const path = ctx.bag.svcPath as string;
        const patterns = this.deletePatterns;
        const cmd = `sh -lc 'nl -ba "${path}" | sed -n -E ${patterns.map((p) => q(`/${p}/p`)).join(' ')}'`;
        const { stdout } = await connectionManager.run(cmd);
        const lines = String(stdout || '').split(/\r?\n/).filter(Boolean);
        lines.forEach((ln) => this.log.info('[unmount.dryrun] ' + ln));
        ctx.bag.dryRunCount = lines.length;
        return 'ok';
      },
    });

    steps.push({ name: 'BACKUP', run: async (ctx: any) => { ctx.bag.backup = await svc.backup(ctx.bag.svcPath); return 'ok'; } });

    steps.push({
      name: 'STOP_CONTAINERS',
      run: async () => {
        await this.guard.stopContainersByMatch('homey', 3, 2000);
        const ok = await this.guard.waitForNoContainers('homey', 15_000, 1000);
        return ok ? 'ok' : 'retry';
      },
      maxIterations: 2,
    });

    steps.push({
      name: 'APPLY_PATCH',
      run: async (ctx: any) => {
        await this.guard.ensureFsRemountRW('/');
        await svc.deleteByRegexPatterns(ctx.bag.svcPath, this.deletePatterns);
        await this.guard.waitForServiceFileChange(ctx.bag.svcPath, 8000, 500);
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
        // 삭제 패턴이 더 이상 존재하지 않아야 함
        for (const rx of this.deletePatterns) {
          const ok = await svc.contains(path, rx);
          if (ok) return 'fail';
        }
        return 'ok';
      },
    });

    steps.push({ name: 'CLEANUP', run: async () => 'ok' });

    const wf = new WorkflowEngine(steps);
    await wf.runAll(`unmount-${Date.now()}`);
  }
}

const DEFAULT_PATTERNS = [
  String.raw`^\s*--volume="homey-app:[^"]+:[^"]+"\s*\\?\s*$`,
  String.raw`^\s*--volume="homey-node:[^"]+:[^"]+"\s*\\?\s*$`,
  String.raw`^\s*-e\s+HOMEY_APP_LOG=1\s*\\?\s*$`,
  String.raw`^\s*-e\s+HOMEY_DEV_TOKEN=1\s*\\?\s*$`,
];

function q(s: string) { return `'${String(s).replace(/'/g, `'''`)}'`; }
