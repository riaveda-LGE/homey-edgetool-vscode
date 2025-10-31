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
        const p = await svc.resolveServicePath();
        ctx.bag.svcPath = p;
        ctx.bag.workPath = await svc.stageToWorkCopy(p);
        this.log.info(`[unmount] unit=${unit} file=${ctx.bag.svcPath}`);
        ctx.bag.hashBefore = await svc.computeHash(ctx.bag.svcPath);
        // 볼륨 삭제 대상 (서비스 파일에서 제거하는 토큰과 동일)
        ctx.bag.volumes = [...this.deletePatterns];
        return 'ok';
      },
    });

    steps.push({
      name: 'DRY_RUN_DIFF',
      run: async (ctx: any) => {
        // BusyBox 호환: nl/sed 조합 대신 grep -nE 로 미리보기
        const path = ctx.bag.workPath as string;
        const patterns = this.deletePatterns;
        const cmd =
          `sh -lc 'grep -nE ${patterns.map((p) => `-e ${q(p)}`).join(' ')} -- ${q(path)} 2>/dev/null || true'`;
        const { stdout } = await connectionManager.run(cmd);
        const lines = String(stdout || '').split(/\r?\n/).filter(Boolean);
        lines.forEach((ln) => this.log.info('[unmount.dryrun] ' + ln));
        ctx.bag.dryRunCount = lines.length;
        return 'ok';
      },
    });

    steps.push({
      name: 'BACKUP',
      run: async (ctx: any) => {
        await this.guard.ensureFsRemountRW('/');
        ctx.bag.backup = await svc.backup(ctx.bag.svcPath);
        return 'ok';
      }
    });

    steps.push({
      name: 'STOP_AND_REMOVE_CONTAINERS',
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
        await svc.deleteByRegexPatterns(ctx.bag.workPath, this.deletePatterns);
        await svc.replaceOriginalWith(ctx.bag.svcPath, ctx.bag.workPath);
        const changed = await this.guard.waitForServiceFileChange(ctx.bag.svcPath, 8000, 500, ctx.bag.hashBefore);
        if (!changed) {
          this.log.error(`[unmount] service file did not change: ${ctx.bag.svcPath}`);
          //throw new Error('patch not applied (no file change detected)');
        }
        return 'ok';
      },
    });
    // 서비스 파일 패치 후 실제 Docker 볼륨을 제거
    steps.push({
      name: 'REMOVE_VOLUMES',
      run: async (ctx: any) => {
        const vols = (ctx.bag.volumes as string[]).filter(Boolean);
        if (!vols.length) return 'ok';
        const ok = await this.guard.removeVolumesByNames(vols, 3, 1500);
        return ok ? 'ok' : 'retry';
      },
      maxIterations: 2,
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
        // ✅ 검증: homey-app, homey-node "중간 문구"가 더 이상 존재하면 실패
        for (const rx of this.deletePatterns) {
          const ok = await svc.contains(path, rx);
          if (ok) {
            this.log.error(`[unmount.verify] token still exists: ${rx}`);
            throw new Error('verification failed (token still present)');
          }
        }
        return 'ok';
      },
    });

    steps.push({ name: 'CLEANUP', run: async () => { await svc.cleanupWorkdir(); return 'ok'; } });

    const wf = new WorkflowEngine(steps);
    await wf.runAll(`unmount-${Date.now()}`);
  }
}

// ✅ 삭제 패턴은 mount 대상 2개만: env 토글(-e ...)은 여기서 건드리지 않음
const DEFAULT_PATTERNS = [
  String.raw`homey-app`,
  String.raw`homey-node`,
];

// 안전 싱글쿼트: ' -> '\'' 로 치환
function q(s: string) { return "'" + String(s).replace(/'/g, `'\\''`) + "'"; }