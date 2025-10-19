// === src/extension/panels/EdgePanelActionRouter.ts ===
import * as vscode from 'vscode';

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
import type { EdgePanelProvider } from './extensionPanel.js';

export interface IEdgePanelActionRouter {
  sendButtonSections(): void;
  dispatchButton(id: string): Promise<void>;
  dispose(): void;
}

export class EdgePanelActionRouter implements IEdgePanelActionRouter {
  private _buttonSections = getSections();
  private _handlers?: ReturnType<typeof createCommandHandlers>;

  constructor(
    private _view: vscode.WebviewView,
    private _context: vscode.ExtensionContext,
    private _extensionUri: vscode.Uri,
    private _appendLog: (line: string) => void,
    private _updateState: { updateAvailable: boolean; updateUrl?: string; latestSha?: string },
    private _provider: EdgePanelProvider,
    private _perfMonitor?: PerfMonitor,
    private _explorer?: ExplorerBridge,
  ) {
    // 🔁 provider 주입된 commandHandlers
    this._handlers = createCommandHandlers(
      (s) => this._appendLog(s),
      this._context,
      this._extensionUri,
      this._provider,
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
        case 'vscode':
          await vscode.commands.executeCommand(op.command, ...(op.args ?? []));
          break;
        case 'post':
          this._view.webview.postMessage({ v: 1, type: op.event, payload: op.payload });
          break;
        case 'handler':
          await this._handlers!.route(op.name);

          // 워크스페이스 관련 후처리
          if (op.name === 'changeWorkspaceQuick' || op.name === 'openWorkspace') {
            await this._explorer?.refreshWorkspaceRoot?.();
          }
          break;
      }
    } catch (e: unknown) {
      this._appendLog(
        `[error] button "${def.label}" failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  dispose() {
    this._handlers = undefined;
  }
}
