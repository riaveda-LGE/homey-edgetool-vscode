// === src/core/tasks/ToggleTaskRunner.ts ===
import { getLogger } from '../logging/extension-logger.js';
import { WorkflowEngine } from './workflow/workflowEngine.js';
import { HostStateGuard } from './guards/HostStateGuard.js';
import { ServiceFilePatcher } from '../service/ServiceFilePatcher.js';
import { resolveHomeyUnit } from '../service/serviceDiscovery.js';

export class ToggleTaskRunner {
  private log = getLogger('ToggleRunner');
  private guard = new HostStateGuard();
  private rx: string;
  private line: string;

  constructor(private varName: 'HOMEY_APP_LOG' | 'HOMEY_DEV_TOKEN', private enable: boolean) {
    this.line = `-e ${varName}=1`;
    this.rx = String.raw`^\s*-e\s+${varName}=1\s*\\?\s*$`;
  }

  async run() {
    const unit = await resolveHomeyUnit();
    const svc = new ServiceFilePatcher(unit);
    const steps: any[] = [];

    steps.push({ name: 'INIT', run: async () => 'ok' });

    steps.push({
      name: 'READ_SERVICE_FILE',
      run: async (ctx: any) => {
        ctx.bag.svcPath = await svc.resolveServicePath();
        ctx.bag.exists = await svc.contains(ctx.bag.svcPath, this.rx);
        return 'ok';
      },
    });

    steps.push({
      name: 'DRY_RUN_DIFF',
      run: async (ctx: any) => {
        const will = this.enable ? (!ctx.bag.exists) : ctx.bag.exists;
        this.log.info(`[toggle ${this.varName}] ${this.enable ? 'enable' : 'disable'} — changes: ${will ? 'YES' : 'NO'}`);
        return 'ok';
      },
    });

    steps.push({ name: 'BACKUP', run: async (ctx: any) => { ctx.bag.backup = await svc.backup(ctx.bag.svcPath); return 'ok'; } });

    steps.push({
      name: 'APPLY_PATCH',
      run: async (ctx: any) => {
        const path = ctx.bag.svcPath as string;
        if (this.enable) {
          if (!ctx.bag.exists) await svc.insertAfterExecStart(path, this.line);
        } else {
          await svc.deleteByRegexPatterns(path, [this.rx]);
        }
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
        const now = await svc.contains(path, this.rx);
        return (this.enable ? now : !now) ? 'ok' : 'fail';
      },
    });

    const wf = new WorkflowEngine(steps);
    await wf.runAll(`toggle-${this.varName}-${Date.now()}`);
  }
}