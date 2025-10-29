// === src/extension/commands/CommandHandlersGit.ts ===
import * as vscode from 'vscode';

import { getCurrentWorkspacePathFs } from '../../core/config/userdata.js';
import { connectionManager } from '../../core/connection/ConnectionManager.js';
import { GitController } from '../../core/controller/GitController.js';
import { HomeyController } from '../../core/controller/HomeyController.js';
import { HostController } from '../../core/controller/HostController.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';

const log = getLogger('cmd.git');
type QPItem<T extends string> = vscode.QuickPickItem & { value: T };

export class CommandHandlersGit {
  constructor(private context?: vscode.ExtensionContext) {}

  @measure()
  async gitFlow() {
    const ws = this.context ? await getCurrentWorkspacePathFs(this.context) : undefined;
    if (!ws) {
      vscode.window.showErrorMessage('작업폴더를 확인할 수 없습니다.');
      return;
    }

    await connectionManager.connect();
    if (!connectionManager.isConnected()) {
      vscode.window.showErrorMessage('활성 연결이 없습니다. 먼저 "기기 연결"을 수행하세요.');
      return;
    }

    const host = new HostController(connectionManager, ws);
    const git = new GitController(host, ws);

    const pickOp = await vscode.window.showQuickPick<QPItem<'pull' | 'push'>>(
      [
        { label: 'Pull', description: '원격 → 로컬 동기화', value: 'pull' },
        { label: 'Push', description: '로컬 변경 → 원격 반영', value: 'push' },
      ],
      { placeHolder: '동작을 선택하세요' },
    );
    if (!pickOp) return;
    log.debug('[debug] gitFlow:op', { op: pickOp.value });

    // ── Push ─────────────────────────────────────────────────
    if (pickOp.value === 'push') {
      const raw = await vscode.window.showInputBox({
        prompt: 'push 대상: (비워두면 전체 변경) 커밋ID 또는 로컬 파일 경로',
        placeHolder: '예) 3f2a7b1 또는 .\\host_sync\\etc\\homey\\config.json',
        ignoreFocusOut: true,
      });
      const arg = raw === undefined ? undefined : raw.trim(); // ''(전체 푸시) 보전
      const hostPath = await vscode.window.showInputBox({
        prompt: 'HostPath (선택) — host_sync 업로드 대상 절대경로를 직접 지정',
        placeHolder: '예) /etc/homey/config.json',
        ignoreFocusOut: true,
      });
      log.debug('[debug] gitFlow:push-args', { arg, hostPath });
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Push', cancellable: false },
        async () => {
          await git.push(arg, { hostPath: hostPath || undefined });
        },
      );
      return;
    }

    // ── Pull ─────────────────────────────────────────────────
    const area = await vscode.window.showQuickPick<QPItem<'homey' | 'host'>>(
      [
        { label: 'Homey', description: '컨테이너 볼륨(pro/core/sdk/bridge)', value: 'homey' },
        { label: 'Host', description: '임의 절대 경로(파일/디렉터리)', value: 'host' },
      ],
      { placeHolder: 'Pull 대상 영역 선택' },
    );
    if (!area) return;
    log.debug('[debug] gitFlow:pull-area', { area: area.value });
    // ── Homey: 마운트 확인 → 없으면 유도 ──────────────────────
    if (area.value === 'homey') {
      const isAnyMounted = async (): Promise<boolean> => {
        const kinds: Array<'pro' | 'core' | 'sdk' | 'bridge'> = ['pro', 'core', 'sdk', 'bridge'];
        for (const k of kinds) {
          const abs = await host.resolveHomeyPath(k);
          const t = await host.statType(abs);
          log.debug('[debug] mountCheck', { kind: k, abs, type: t });
          if (t === 'DIR') return true;
        }
        return false;
      };
      if (!(await isAnyMounted())) {
        const act = await vscode.window.showWarningMessage(
          'Homey 볼륨이 마운트되지 않은 것 같습니다. 지금 마운트를 시도할까요?',
          '지금 마운트',
          '취소',
        );
        if (act === '지금 마운트') {
          const hc = new HomeyController();
          await hc.mount();
        } else {
          return;
        }
      }
    }

    if (area.value === 'host') {
      const hostAbsPath = await vscode.window.showInputBox({
        prompt: '호스트 절대 경로',
        placeHolder: '/etc/homey/config.json 또는 /lg_rw/var/lib/docker/…',
        ignoreFocusOut: true,
      });
      if (!hostAbsPath) return;
      const localPath = await vscode.window.showInputBox({
        prompt: '로컬 저장 경로(선택) — 없으면 host_sync 매핑에 저장',
        placeHolder: '예) D:\\tmp\\config.json 또는 ./tmp/config.json',
        ignoreFocusOut: true,
      });
      if (localPath === undefined) return;
      log.debug('[debug] gitFlow:host-pull-args', { hostAbsPath, localPath });

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Pull: Host', cancellable: false },
        async (p) => {
          p.report({ message: '전송 중…' });
          await git.pull('host', hostAbsPath, {
            localPath: localPath || undefined, // 빈 문자열이면 undefined로
          });
        },
      );
      return;
    }
    // Homey
    const picks = await vscode.window.showQuickPick(
      [
        { label: 'pro', description: 'homey_pro (컨테이너 볼륨)' },
        { label: 'core', description: 'homey_core (컨테이너 볼륨)' },
        { label: 'sdk', description: 'homey-apps-sdk-v3 (컨테이너 볼륨)' },
        { label: 'bridge', description: 'homey-bridge (컨테이너 볼륨)' },
      ],
      { placeHolder: '받을 대상을 선택하세요 (다중 선택 가능)', canPickMany: true },
    );
    if (!picks || picks.length === 0) return;
    log.debug('[debug] gitFlow:homey-picks', { picks: picks.map((p) => p.label) });

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Pull: Homey', cancellable: false },
      async (p) => {
        for (const it of picks) {
          const kind = it.label as 'pro' | 'core' | 'sdk' | 'bridge';
          p.report({ message: `downloading ${kind}…` });
          await git.pull(kind, undefined);
        }
      },
    );
  }
}
