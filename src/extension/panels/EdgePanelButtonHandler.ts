// === src/extension/panels/EdgePanelButtonHandler.ts ===
import * as vscode from 'vscode';
import { downloadAndInstall } from '../update/updater.js';
import { createCommandHandlers } from '../commands/commandHandlers.js';
import {
  buildButtonContext,
  type ButtonDef,
  findButtonById,
  getSections,
  toSectionDTO,
} from '../commands/edgepanel.buttons.js';
import type { PerfMonitor } from '../editors/PerfMonitorEditorProvider.js';
import type { ExplorerBridge } from './explorerBridge.js';

export interface IEdgePanelButtonHandler {
  sendButtonSections(): void;
  dispatchButton(id: string): Promise<void>;
  dispose(): void;
}

export class EdgePanelButtonHandler implements IEdgePanelButtonHandler {
  private _buttonSections = getSections();
  private _handlers?: ReturnType<typeof createCommandHandlers>;

  constructor(
    private _view: vscode.WebviewView,
    private _context: vscode.ExtensionContext,
    private _extensionUri: vscode.Uri,
    private _appendLog: (line: string) => void,
    private _updateState: { updateAvailable: boolean; updateUrl?: string; latestSha?: string },
    private _perfMonitor?: PerfMonitor,
    private _explorer?: ExplorerBridge,
  ) {
    // 핸들러 초기화 (한 번만)
    this._handlers = createCommandHandlers(
      (s) => this._appendLog(s),
      this._context,
      this._extensionUri
    );
  }

  sendButtonSections() {
    const ctx = buildButtonContext({
      updateAvailable: this._updateState.updateAvailable,
      updateUrl: this._updateState.updateUrl,
    });
    const dto = toSectionDTO(this._buttonSections, ctx);
    this._view.webview.postMessage({ v: 1, type: 'buttons.set', payload: { sections: dto } });
  }

  async dispatchButton(id: string) {
    const def = findButtonById(this._buttonSections, id);
    if (!def) {
      this._appendLog(`[warn] unknown button id: ${id}`);
      return;
    }
    await this._runOp(def);
  }

  private async _runOp(def: ButtonDef) {
    const op = def.op;
    try {
      switch (op.kind) {
        case 'line': {
          await this._handlers!.route(op.line);
          // changeWorkspaceQuick 같은 라인이면 여기서도 워처 재바인딩 시도 (보수적)
          if (/changeWorkspace/i.test(op.line ?? '')) {
            await this._explorer?.refreshWorkspaceRoot?.();
          }
          break;
        }
        case 'vscode':
          await vscode.commands.executeCommand(op.command, ...(op.args ?? []));
          break;
        case 'post':
          this._view.webview.postMessage({ v: 1, type: op.event, payload: op.payload });
          break;
        case 'handler':
          if (op.name === 'togglePerformanceMonitoring') {
            // 성능 모니터링 패널 열기
            if (this._perfMonitor) {
              this._perfMonitor.createPanel();
              vscode.window.showInformationMessage('Performance Monitor opened.');
            } else {
              vscode.window.showErrorMessage('Performance Monitor is not available.');
            }
          } else if (op.name === 'updateNow') {
            await downloadAndInstall(this._updateState.updateUrl!, this._updateState.latestSha!);
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
          } else if (op.name === 'changeWorkspaceQuick') {
            await this._handlers!.route('changeWorkspaceQuick');
          } else if (op.name === 'openWorkspace') {
            await this._handlers!.route('openWorkspace');
          } else if (op.name === 'openHelp') {
            await this._handlers!.route('help');
          } else {
            await this._handlers!.route(op.name);
          }
          // UI 후처리: 워크스페이스 변경 시 explorer refresh
          if (op.name === 'changeWorkspaceQuick' || op.name === 'openWorkspace') {
            await this._explorer?.refreshWorkspaceRoot?.();
          }
          break;
      }
    } catch (e: unknown) {
      this._appendLog(`[error] button "${def.label}" failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  dispose() {
    this._handlers = undefined;
  }
}
