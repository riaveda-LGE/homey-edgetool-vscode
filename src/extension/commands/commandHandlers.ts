// === src/extension/commands/commandHandlers.ts ===
import * as vscode from 'vscode';
import * as path from 'path';
import { promisify } from 'util';
import { exec as execCb } from 'child_process';

// 사용자 구성 저장소
import { changeWorkspaceBaseDir, resolveWorkspaceInfo } from '../../core/config/userdata.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { checkLatestVersion, downloadAndInstall } from '../update/updater.js';
import { measure } from '../../core/logging/perf.js';
import { PerfMonitorPanel } from '../editors/PerfMonitorPanel.js';

const log = getLogger('cmd');
const exec = promisify(execCb);

class CommandHandlers {
  private say: (s: string) => void;

  constructor(
    private appendLog?: (s: string) => void,
    private context?: vscode.ExtensionContext,
    private extensionUri?: vscode.Uri,
  ) {
    this.say = (s: string) => {
      log.info(s);
      this.appendLog?.(s);
    };
  }

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
      case 'updateNow':
        return this.updateNow();
      case 'openHelp':
        return this.openHelp();
      case 'changeWorkspaceQuick':
        return this.changeWorkspaceQuick();
      case 'openWorkspace':
        return this.openWorkspace();
      case 'togglePerformanceMonitoring':
        return this.togglePerformanceMonitoring();
      default:
        this.say(`[info] unknown command: ${raw}`);
    }
  }

  async help() {
    this.say(`Commands:
  help | h
  homey-logging
  connect_info | connect_change
  host <cmd>
  git pull|push ...
  change_workspace`);
  }

  async loggingStart() {
    this.say('[info] start realtime logging (stub)');
  }

  async loggingMerge(dir: string) {
    if (!dir) return this.say('[error] directory path required');
    this.say(`[info] start file-merge logging for ${dir} (stub)`);
  }

  async loggingStop() {
    this.say('[info] logging stopped (stub)');
  }

  async connectInfo() {
    this.say('[info] connect_info (stub)');
  }

  async connectChange() {
    this.say('[info] connect_change (stub)');
  }

  async hostCommand(cmd: string) {
    if (!cmd) return this.say('[error] host <command>');
    this.say(`[info] host passthrough: ${cmd} (stub)`);
  }

  async gitPassthrough(args: string[]) {
    this.say(`[info] git ${args.join(' ')} (stub)`);
  }

  @measure()
  async updateNow() {
    try {
      const version =
        vscode.extensions.getExtension('lge.homey-edgetool')?.packageJSON?.version ?? '0.0.0';
      const latest = await checkLatestVersion(String(version));
      if (!latest.hasUpdate || !latest.url || !latest.sha256) {
        vscode.window.showInformationMessage('No update available or invalid update info.');
        return;
      }
      const out = (s: string) => this.appendLog?.(s);
      await downloadAndInstall(latest.url, latest.sha256, (downloaded, total) => {
        out(`Downloading: ${downloaded}/${total} bytes`);
      });
    } catch (e) {
      log.error('updateNow failed', e as any);
      vscode.window.showErrorMessage('Update failed: ' + (e as Error).message);
    }
  }

  @measure()
  async openHelp() {
    if (!this.extensionUri) return this.say('[error] internal: no extension uri');
    try {
      const helpUri = vscode.Uri.joinPath(this.extensionUri, 'media', 'resources', 'help.md');
      await vscode.workspace.fs.stat(helpUri);
      const doc = await vscode.workspace.openTextDocument(helpUri);
      await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
    } catch {
      this.say('[warn] help.md를 찾을 수 없습니다: media/resources/help.md');
      vscode.window.showWarningMessage(
        'help.md를 찾을 수 없습니다. media/resources/help.md 위치에 파일이 있는지 확인하세요.',
      );
    }
  }

  // === 안내 팝업 없이 바로 폴더 선택(패널 버튼 전용)
  @measure()
  async changeWorkspaceQuick() {
    if (!this.context) return this.say('[error] internal: no extension context');

    const info = await resolveWorkspaceInfo(this.context);
    const sel = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select folder',
      title: '새 Workspace 베이스 폴더 선택 (그 하위에 workspace/가 생성됩니다)',
      defaultUri: info.baseDirUri,
    });
    if (!sel || !sel[0]) return this.say('[info] change_workspace cancelled');

    const picked = sel[0].fsPath;
    const baseForConfig =
      path.basename(picked).toLowerCase() === 'workspace'
        ? path.dirname(picked)
        : picked;

    try {
      const updated = await changeWorkspaceBaseDir(this.context, baseForConfig);
      await ensureGitInit(updated.wsDirFsPath, this.say);
      this.say(`[info] workspace (사용자 지정) base=${updated.baseDirFsPath}`);
      this.say(`[info] -> 실제 사용 경로: ${updated.wsDirFsPath}`);

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
      this.say(`[error] change_workspace 실패: ${e?.message || String(e)}`);
    }
  }

  // === Workspace 열기: 항상 폴더 내부를 연다
  @measure()
  async openWorkspace() {
    if (!this.context) return this.say('[error] internal: no extension context');
    try {
      const info = await resolveWorkspaceInfo(this.context);
      await vscode.env.openExternal(info.wsDirUri);
    } catch (e: any) {
      this.say(`[warn] workspace open failed: ${e?.message || String(e)}`);
      vscode.window.showWarningMessage('Workspace가 아직 설정되지 않았습니다.');
    }
  }

  // (옵션) 현재 상태 확인용
  async showWorkspace() {
    if (!this.context) return this.say('[error] internal: no extension context');
    const info = await resolveWorkspaceInfo(this.context);
    if (info.source === 'user') {
      this.say(`[info] workspace (사용자 지정) base=${info.baseDirFsPath}`);
    } else {
      this.say(`[info] workspace (기본) base=${info.baseDirFsPath} (확장전용폴더)`);
    }
    this.say(`[info] -> 실제 사용 경로: ${info.wsDirFsPath}`);
  }

  @measure()
  async togglePerformanceMonitoring() {
    if (!this.context || !this.extensionUri) return this.say('[error] internal: no context or extension uri');

    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Performance Monitoring On', description: '실시간 모니터링 시작' },
        { label: 'Performance Monitoring Off', description: '모니터링 중지' },
      ],
      { placeHolder: 'Performance Monitoring을 선택하세요' },
    );
    if (!pick) return;

    const panel = new PerfMonitorPanel(this.extensionUri, this.context);
    if (pick.label === 'Performance Monitoring On') {
      panel.startMonitoring();
      panel.createPanel();
      this.say('[info] Performance Monitoring started');
    } else {
      panel.stopMonitoring();
      panel.closePanel();
      this.say('[info] Performance Monitoring stopped');
    }
  }
}

export function createCommandHandlers(
  appendLog?: (s: string) => void,
  context?: vscode.ExtensionContext,
  extensionUri?: vscode.Uri,
) {
  return new CommandHandlers(appendLog, context, extensionUri);
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
