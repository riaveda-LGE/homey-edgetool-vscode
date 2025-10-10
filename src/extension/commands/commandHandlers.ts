// === src/extension/commands/commandHandlers.ts ===
import * as vscode from 'vscode';
import { getLogger } from '../../core/logging/extension-logger.js';
import { checkLatestVersion, downloadAndInstall } from '../update/updater.js';
import { READY_MARKER } from '../../shared/const.js';

// 사용자 구성 저장소
import {
  changeWorkspaceBaseDir,
  resolveWorkspaceInfo,
} from '../../core/config/userdata.js';

const log = getLogger('cmd');

export function createCommandHandlers(appendLog?: (s: string) => void, context?: vscode.ExtensionContext) {
  const say = (s: string) => {
    log.info(s);
    appendLog?.(s);
  };

  return {
    async route(raw: string) {
      const [cmd, ...rest] = String(raw || '').trim().split(/\s+/);
      switch (cmd) {
        case 'help':
        case 'h':
          return this.help();
        case 'homey-logging': {
          if (rest[0] === '--stop') return this.loggingStop();
          if (rest[0] === '--dir') return this.loggingMerge(rest.slice(1).join(' ').trim());
          return this.loggingStart();
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
  homey-logging --stop
  homey-logging --dir <path>
  connect_info | connect_change
  host <cmd>
  git pull|push ...
  change_workspace [<절대경로>]`);
    },

    async loggingStart() {
      say('[info] start realtime logging (stub)');
      // TODO: LogSessionManager 연동
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
      let base = arg?.trim();

      if (!base) {
        base =
          (await vscode.window.showInputBox({
            title:
              '새 Workspace 베이스 절대 경로 입력 (해당 경로 아래에 workspace/가 생성됩니다)',
            placeHolder: '예) D:\\homey-data   또는   /Users/me/homey-data',
            validateInput: (v) =>
              v && v.length > 1 ? undefined : '경로를 입력하세요',
          })) || '';
      }
      if (!base) return say('[info] change_workspace 취소됨');

      try {
        const info = await changeWorkspaceBaseDir(context, base);
        say(`[info] workspace (사용자 지정) base=${info.baseDirFsPath}`);
        say(`[info] -> 실제 사용 경로: ${info.wsDirFsPath}`);
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
