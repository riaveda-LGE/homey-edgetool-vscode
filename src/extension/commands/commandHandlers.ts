// === src/extension/commands/commandHandlers.ts ===
import * as vscode from 'vscode';
import * as path from 'path';
import { promisify } from 'util';
import { exec as execCb } from 'child_process';

// 사용자 구성 저장소
import { changeWorkspaceBaseDir, resolveWorkspaceInfo } from '../../core/config/userdata.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { READY_MARKER } from '../../shared/const.js';
import { checkLatestVersion, downloadAndInstall } from '../update/updater.js';

const log = getLogger('cmd');
const exec = promisify(execCb);

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
          return this.changeWorkspaceQuick();
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
  change_workspace`);
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

    // === 안내 팝업 없이 바로 폴더 선택(패널 버튼 전용)
    async changeWorkspaceQuick() {
      if (!context) return say('[error] internal: no extension context');

      const info = await resolveWorkspaceInfo(context);
      const sel = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select folder',
        title: '새 Workspace 베이스 폴더 선택 (그 하위에 workspace/가 생성됩니다)',
        defaultUri: info.baseDirUri,
      });
      if (!sel || !sel[0]) return say('[info] change_workspace cancelled');

      const picked = sel[0].fsPath;
      const baseForConfig =
        path.basename(picked).toLowerCase() === 'workspace'
          ? path.dirname(picked)
          : picked;

      try {
        const updated = await changeWorkspaceBaseDir(context, baseForConfig);
        await ensureGitInit(updated.wsDirFsPath, say);
        say(`[info] workspace (사용자 지정) base=${updated.baseDirFsPath}`);
        say(`[info] -> 실제 사용 경로: ${updated.wsDirFsPath}`);

        const openNow = await vscode.window.showInformationMessage(
          '새 Workspace가 설정되었습니다. 바로 열어볼까요?',
          'Open folder',
          'No',
        );
        if (openNow === 'Open folder') {
          // 폴더 '안'을 바로 연다
          await vscode.env.openExternal(updated.wsDirUri);
        }
      } catch (e: any) {
        say(`[error] change_workspace 실패: ${e?.message || String(e)}`);
      }
    },

    // === Workspace 열기: 항상 폴더 내부를 연다
    async openWorkspace() {
      if (!context) return say('[error] internal: no extension context');
      try {
        const info = await resolveWorkspaceInfo(context);
        await vscode.env.openExternal(info.wsDirUri);
      } catch (e: any) {
        say(`[warn] workspace open failed: ${e?.message || String(e)}`);
        vscode.window.showWarningMessage('Workspace가 아직 설정되지 않았습니다.');
      }
    },

    // (옵션) 현재 상태 확인용
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

async function ensureGitInit(dir: string, say?: (s: string) => void) {
  try {
    // 이미 .git 있으면 패스
    await vscode.workspace.fs.stat(vscode.Uri.file(path.join(dir, '.git')));
    return;
  } catch {}

  try {
    say?.(`[info] git init in: ${dir}`);
    await exec('git init', { cwd: dir });
    say?.('[info] git init done');
  } catch (e: any) {
    say?.(`[warn] git init failed: ${e?.message || String(e)}`);
  }
}
