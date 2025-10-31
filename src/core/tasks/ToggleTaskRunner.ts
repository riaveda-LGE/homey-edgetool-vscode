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
    // ✅ 토글 존재 체크/삭제는 "중간 문구" 기준(값/백슬래시 등은 무시)
    this.line = `--env="${varName}=1"`;
    this.rx = varName; // grep -E 로 중간 포함 매칭
  }

  async run() {
    const unit = await resolveHomeyUnit();
    const svc = new ServiceFilePatcher(unit);
    const steps: any[] = [];

    steps.push({ name: 'INIT', run: async () => 'ok' });

    steps.push({
      name: 'READ_SERVICE_FILE',
      run: async (ctx: any) => {
        const p = await svc.resolveServicePath();
        ctx.bag.svcPath = p;
        ctx.bag.workPath = await svc.stageToWorkCopy(p);
        this.log.info(`[toggle ${this.varName}] unit=${unit} file=${ctx.bag.svcPath}`);
        ctx.bag.exists = await svc.contains(ctx.bag.workPath, this.rx);
        ctx.bag.hashBefore = await svc.computeHash(p);
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

    steps.push({
      name: 'BACKUP',
      run: async (ctx: any) => {
        // edge-go: 변경 전 루트 RW 리마운트
        await this.guard.ensureFsRemountRW('/');
        ctx.bag.backup = await svc.backup(ctx.bag.svcPath);
        return 'ok';
      }
    });

    steps.push({
      name: 'APPLY_PATCH',
      run: async (ctx: any) => {
        const path = ctx.bag.svcPath as string;
        const work = ctx.bag.workPath as string;
        if (this.enable) {
          if (!ctx.bag.exists) await svc.insertAfterExecStart(work, this.line);
        } else {
          await svc.deleteByRegexPatterns(work, [this.rx]); // varName 토큰 포함 줄 삭제
        }
         await this.guard.ensureFsRemountRW('/');
        await svc.replaceOriginalWith(path, work);
        const changed = await this.guard.waitForServiceFileChange(path, 8000, 500, ctx.bag.hashBefore);
         if (!changed) {
           this.log.error(`[toggle ${this.varName}] service file did not change: ${path}`);
           throw new Error('patch not applied (no file change detected)');
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
        const now = await svc.contains(path, this.rx); // 중간 문구 존재 여부
        const ok = this.enable ? now : !now;
         if (!ok) {
           this.log.error(`[toggle ${this.varName}] verification failed`);
           throw new Error('verification failed (env toggle mismatch)');
         }
         return 'ok';
      },
    });

    steps.push({ name: 'CLEANUP', run: async () => { await svc.cleanupWorkdir(); return 'ok'; } });

    const wf = new WorkflowEngine(steps);
    await wf.runAll(`toggle-${this.varName}-${Date.now()}`);
  }
}