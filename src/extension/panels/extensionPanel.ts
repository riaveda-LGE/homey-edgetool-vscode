// === src/extension/panels/extensionPanel.ts ===
import * as fs from 'fs';
import * as vscode from 'vscode';

import {
  addLogSink,
  getBufferedLogs,
  getLogger,
  removeLogSink,
} from '../../core/logging/extension-logger.js';
import { readFileAsText } from '../../shared/utils.js';
import { PANEL_VIEW_TYPE, RANDOM_STRING_LENGTH } from '../../shared/const.js';
import { createExplorerBridge, type ExplorerBridge } from './explorerBridge.js';
import type { PerfMonitor } from '../editors/PerfMonitorEditorProvider.js';
import { measure } from '../../core/logging/perf.js';
import { EdgePanelConnectionManager } from './EdgePanelConnectionManager.js';
import { EdgePanelLogViewer } from './EdgePanelLogViewer.js';
import { EdgePanelButtonHandler, type IEdgePanelButtonHandler } from './EdgePanelButtonHandler.js';

interface EdgePanelState {
  version: string;
  updateAvailable: boolean;
  latestVersion?: string;
  updateUrl?: string;
  latestSha?: string;
  lastCheckTime?: string;
  logs?: string[];
}

export class EdgePanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = PANEL_VIEW_TYPE;
  private _view?: vscode.WebviewView;
  private _sink?: (line: string) => void;
  private log = getLogger('edgePanel');
  private _state: EdgePanelState;

  private _perfMonitor?: PerfMonitor;
  private _explorer?: ExplorerBridge;
  private _buttonHandler?: IEdgePanelButtonHandler;
  private _logViewer?: EdgePanelLogViewer;

  // 메모리 관리: 이벤트 리스너 추적
  private _disposables = new Set<() => void>();

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
    version: string,
    latestInfo?: { hasUpdate?: boolean; latest?: string; url?: string; sha256?: string },
    perfMonitor?: PerfMonitor,
  ) {
    this._perfMonitor = perfMonitor;
    this._state = {
      version,
      updateAvailable: !!latestInfo?.hasUpdate,
      latestVersion: latestInfo?.latest,
      updateUrl: latestInfo?.url,
      latestSha: latestInfo?.sha256,
      lastCheckTime: new Date().toISOString(),
      logs: getBufferedLogs(),
    };
  }

  public appendLog(line: string) {
    this._view?.webview.postMessage({ type: 'appendLog', text: line });
  }

  // 메모리 관리 헬퍼
  private _trackDisposable(disposable: () => void) {
    this._disposables.add(disposable);
  }

  private _disposeTracked() {
    // 일반 disposables 정리
    for (const dispose of this._disposables) {
      try { dispose(); } catch (e) { this.log.warn(`dispose error: ${e}`); }
    }
    this._disposables.clear();
  }

  async resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;

    const uiRoot = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webviewers', 'edge-panel');

    webviewView.webview.options = {
      enableScripts: true,
      ...({ retainContextWhenHidden: true } as any),
      localResourceRoots: [uiRoot],
    };
    webviewView.title = `Edge Console - v${this._state.version}`;

    try {
      webviewView.webview.html = await this._getHtmlFromFiles(webviewView.webview, uiRoot);
    } catch (e: unknown) {
      const msg = `Failed to load panel HTML: ${e instanceof Error ? e.message : String(e)}`;
      this.log.error(msg);
      vscode.window.showErrorMessage(msg);
      webviewView.webview.html = `<html><body style="color:#ddd;background:#1e1e1e;font-family:ui-monospace,Consolas,monospace;padding:12px">
        <h3>Edge Console</h3>
        <pre>${msg}</pre>
      </body></html>`;
      return;
    }

    // Explorer 브리지
    this._explorer = createExplorerBridge(this._context, (m) => {
      try { webviewView.webview.postMessage(m); } catch {}
    });

    // 버튼 핸들러
    this._buttonHandler = new EdgePanelButtonHandler(
      webviewView,
      this._context,
      this._extensionUri,
      (line) => this.appendLog(line),
      {
        updateAvailable: this._state.updateAvailable,
        updateUrl: this._state.updateUrl,
        latestSha: this._state.latestSha
      },
      this._perfMonitor,
      this._explorer
    );

    // 로그 뷰어
    this._logViewer = new EdgePanelLogViewer(
      this._context,
      this._extensionUri,
      (line) => this.appendLog(line)
    );

    // Webview -> Extension
    const messageDisposable = webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (this._explorer && (await this._explorer.handleMessage(msg))) return;

        if (msg?.type === 'ui.requestButtons') {
          this._buttonHandler?.sendButtonSections();
          return;
        }

        if (msg?.type === 'ui.log' && msg?.v === 1) {
          const lvl = String(msg.payload?.level ?? 'info') as 'debug' | 'info' | 'warn' | 'error';
          const text = String(msg.payload?.text ?? '');
          const src = String(msg.payload?.source ?? 'ui.edgePanel');
          const lg = getLogger(src);
          (lg[lvl] ?? lg.info).call(lg, text);
          return;
        } else if (msg?.command === 'ready') {
          this._state.logs = getBufferedLogs();
          webviewView.webview.postMessage({ type: 'initState', state: this._state });
          webviewView.webview.postMessage({
            type: 'setUpdateVisible',
            visible: !!(this._state.updateAvailable && this._state.updateUrl),
          });
          this._buttonHandler?.sendButtonSections();
        } else if (msg?.command === 'reloadWindow') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        } else if (msg?.type === 'button.click' && typeof msg.id === 'string') {
          await this._buttonHandler?.dispatchButton(msg.id);
        }
      } catch (e) {
        this.log.error('onDidReceiveMessage error', e as any);
      }
    });
    this._trackDisposable(() => messageDisposable.dispose());

    const visibilityDisposable = webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) return;
      try {
        const state = { ...this._state, logs: getBufferedLogs() };
        webviewView.webview.postMessage({ type: 'initState', state });
        this._buttonHandler?.sendButtonSections();
      } catch {}
    });
    this._trackDisposable(() => visibilityDisposable.dispose());

    // OutputChannel -> EdgePanel
    this._sink = (line: string) => {
      try { webviewView.webview.postMessage({ type: 'appendLog', text: line }); } catch {}
    };
    addLogSink(this._sink);

    webviewView.onDidDispose(() => {
      this._disposeTracked();

      if (this._sink) removeLogSink(this._sink);
      this._sink = undefined;

      try { this._explorer?.dispose(); } catch {}
      this._explorer = undefined;

      this._buttonHandler?.dispose();
      this._buttonHandler = undefined;

      this._logViewer?.dispose();
      this._logViewer = undefined;

      this._view = undefined;
    });
  }

  @measure()
  public async handleHomeyLoggingCommand() {
    await this._logViewer?.handleHomeyLoggingCommand();
  }

  private async _getHtmlFromFiles(webview: vscode.Webview, mediaRoot: vscode.Uri): Promise<string> {
    const htmlPath = vscode.Uri.joinPath(mediaRoot, 'index.html');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.js'));
    const nonce = getNonce();
    const cspSource = webview.cspSource;

    let html = await readFileAsText(htmlPath);
    html = html
      .replace(/%CSS_URI%/g, String(cssUri))
      .replace(/%JS_URI%/g, String(jsUri))
      .replace(/%NONCE%/g, nonce)
      .replace(/%CSP_SOURCE%/g, cspSource);
    return html;
  }
}

export function registerEdgePanelCommands(
  context: vscode.ExtensionContext,
  provider: EdgePanelProvider,
  perfMonitor?: PerfMonitor,
) {
  // Performance Monitor를 provider에 설정
  if (perfMonitor) {
    (provider as any)._perfMonitor = perfMonitor;
  }

  const d = vscode.commands.registerCommand('homeyEdgetool.openHomeyLogging', async () => {
    await provider.handleHomeyLoggingCommand();
  });
  context.subscriptions.push(d);
}

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < RANDOM_STRING_LENGTH; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}