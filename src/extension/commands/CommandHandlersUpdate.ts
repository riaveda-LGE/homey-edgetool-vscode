// === src/extension/commands/CommandHandlersUpdate.ts ===
import * as vscode from 'vscode';
import { checkLatestVersion, downloadAndInstall } from '../update/updater.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';

const log = getLogger('cmd.update');

export class CommandHandlersUpdate {
  constructor(
    private say: (s: string) => void,
    private appendLog?: (s: string) => void,
    private extensionUri?: vscode.Uri,
  ) {}

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
}
