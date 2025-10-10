// === src/extension/commands/commandHandlers.ts ===
import * as vscode from 'vscode';

// 사용자 구성 저장소
import { changeWorkspaceBaseDir, resolveWorkspaceInfo } from '../../core/config/userdata.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { READY_MARKER } from '../../shared/const.js';
import { checkLatestVersion, downloadAndInstall } from '../update/updater.js';

const log = getLogger('cmd');

export function createCommandHandlers(
  appendLog?: (s: string) => void,
  context?: vscode.ExtensionContext,
) {
  const say = (s: string) => {
    log.info(s);
    appendLog?.(s);
  };

  return {
    async route(raw: string) {
      const [cmd, ...rest] = String(raw || '')
        .trim()
        .split(/\s+/);
      switch (cmd) {
        case 'help':
        case 'h':
          return this.help();
        case 'homey-logging': {
          // ✅ EdgePanel의 공개 커맨드로 위임 (UI에서 모드 선택 + 세션 시작)
          await vscode.commands.executeCommand('homeyEdgetool.openHomeyLogging');
          return;
        }
        case 'connect_info':
          return this.connectInfo();
        case 'connect_change':
          return this.connectChange();
        case 'host':
          return this.hostCommand(rest.join(' '));
        case 'git':
          return this.gitPassthrough(rest);
        case 'change_workspace':
          return this.changeWorkspace(rest.join(' '));
        default:
          say(`[info] unknown command: ${raw}`);
      }
    },

    async help() {
      say(`${READY_MARKER} Commands:
  help | h
  homey-logging
  connect_info | connect_change
  host <cmd>
  git pull|push ...
  change_workspace [<절대경로>]`);
    },

    async loggingStart() {
      say('[info] start realtime logging (stub)');
    },

    async loggingMerge(dir: string) {
      if (!dir) return say('[error] directory path required');
      say(`[info] start file-merge logging for ${dir} (stub)`);
    },

    async loggingStop() {
      say('[info] logging stopped (stub)');
    },

    async connectInfo() {
      say('[info] connect_info (stub)');
    },

    async connectChange() {
      say('[info] connect_change (stub)');
    },

    async hostCommand(cmd: string) {
      if (!cmd) return say('[error] host <command>');
      say(`[info] host passthrough: ${cmd} (stub)`);
    },

    async gitPassthrough(args: string[]) {
      say(`[info] git ${args.join(' ')} (stub)`);
    },

    async updateNow() {
      try {
        const version =
          vscode.extensions.getExtension('lge.homey-edgetool')?.packageJSON?.version ?? '0.0.0';
        const latest = await checkLatestVersion(String(version));
        if (!latest.hasUpdate || !latest.url) {
          vscode.window.showInformationMessage('No update available.');
          return;
        }
        const out = (s: string) => appendLog?.(s);
        await downloadAndInstall(latest.url, out, latest.sha256);
      } catch (e) {
        log.error('updateNow failed', e as any);
        vscode.window.showErrorMessage('Update failed: ' + (e as Error).message);
      }
    },

    async changeWorkspace(arg: string) {
      if (!context) return say('[error] internal: no extension context');

      // 1) 사용자가 인자로 경로를 직접 줬으면 그걸 사용
      let base = arg?.trim();

      // 2) 인자가 없으면 액션 버튼 제공
      if (!base) {
        // 현재 워크스페이스 안내 & 바로 열기
        const info = await resolveWorkspaceInfo(context);
        const currentBase = info.baseDirFsPath;
        const currentWs = info.wsDirFsPath;

        const pick = await vscode.window.showInformationMessage(
          `현재 Workspace\n- base: ${currentBase}\n- 실제 사용: ${currentWs}`,
          { modal: false, detail: 'Browse를 눌러 새 베이스 폴더를 선택할 수 있어요.' },
          'Browse…',
          'Open current',
          'Cancel',
        );

        if (pick === 'Open current') {
          try {
            await vscode.commands.executeCommand('revealFileInOS', info.wsDirUri);
          } catch {
            // 일부 플랫폼에서 reveal이 폴더에선 동작 안 할 때가 있어요 → openExternal로 폴백
            await vscode.env.openExternal(info.wsDirUri);
          }
          // 다시 버튼 보여주기보단 종료
          return;
        }
        if (pick === 'Cancel' || !pick) {
          return say('[info] change_workspace cancelled');
        }

        // 3) 폴더 브라우저 (네이티브, 포커스 잃어도 안 사라짐)
        const sel = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Select folder',
          title: '새 Workspace 베이스 폴더 선택 (그 하위에 workspace/가 생성됩니다)',
          defaultUri: info.baseDirUri, // 현재 베이스를 기본 위치로
        });
        if (!sel || !sel[0]) return say('[info] change_workspace cancelled');
        base = sel[0].fsPath;
      }

      // 4) 변경 적용
      try {
        const updated = await changeWorkspaceBaseDir(context, base);
        say(`[info] workspace (사용자 지정) base=${updated.baseDirFsPath}`);
        say(`[info] -> 실제 사용 경로: ${updated.wsDirFsPath}`);

        // 선택 직후 곧바로 열어보기(선택 사항)
        const openNow = await vscode.window.showInformationMessage(
          '새 Workspace가 설정되었습니다. 바로 열어볼까요?',
          'Open folder',
          'No',
        );
        if (openNow === 'Open folder') {
          try {
            await vscode.commands.executeCommand('revealFileInOS', updated.wsDirUri);
          } catch {
            await vscode.env.openExternal(updated.wsDirUri);
          }
        }
      } catch (e: any) {
        say(`[error] change_workspace 실패: ${e?.message || String(e)}`);
      }
    },

    // (옵션) 현재 상태 확인용: 필요 시 help에 노출하고 쓰면 됨
    async showWorkspace() {
      if (!context) return say('[error] internal: no extension context');
      const info = await resolveWorkspaceInfo(context);
      if (info.source === 'user') {
        say(`[info] workspace (사용자 지정) base=${info.baseDirFsPath}`);
      } else {
        say(`[info] workspace (기본) base=${info.baseDirFsPath} (확장전용폴더)`);
      }
      say(`[info] -> 실제 사용 경로: ${info.wsDirFsPath}`);
    },
  };
}
