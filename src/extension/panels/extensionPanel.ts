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
import { readEdgePanelState, writeEdgePanelState } from '../../core/config/userdata.js';

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
    this._view?.webview.postMessage({ v: 1, type: 'appendLog', payload: { text: line } });
  }

  // 메모리 관리 헬퍼
  private _trackDisposable(disposable: () => void) {
    this._disposables.add(disposable);
  }

  private _disposeTracked() {
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

        if (msg?.type === 'workspace.ensure' && msg?.v === 1) {
          await this._explorer?.refreshWorkspaceRoot();
          return;
        }

        if (msg?.type === 'ui.requestButtons' && msg?.v === 1) {
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
        } else if (msg?.type === 'ui.ready' && msg?.v === 1) {
          this._state.logs = getBufferedLogs();
          const panelState = await readEdgePanelState(this._context);
          webviewView.webview.postMessage({ v: 1, type: 'initState', payload: { state: this._state, panelState } });
          webviewView.webview.postMessage({ v: 1, type: 'setUpdateVisible', payload: { visible: !!(this._state.updateAvailable && this._state.updateUrl) } });
          this._buttonHandler?.sendButtonSections();

          // 저장된 상태에서 Explorer가 켜져 있으면 초기화
          if (panelState.showExplorer) {
            await this._explorer?.refreshWorkspaceRoot();
          }
        } else if (msg?.type === 'ui.savePanelState' && msg?.v === 1) {
          await writeEdgePanelState(this._context, msg.payload.panelState);
        } else if (msg?.command === 'reloadWindow') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        } else if (msg?.type === 'button.click' && msg?.v === 1 && typeof msg.payload.id === 'string') {
          await this._buttonHandler?.dispatchButton(msg.payload.id);
        }
      } catch (e) {
        this.log.error('onDidReceiveMessage error', e as any);
      }
    });
    this._trackDisposable(() => messageDisposable.dispose());

    // =========================
    // 안전망: 포커스/가시성 변화 시 선택 해제 신호 보내기
    // =========================

    // 뷰 가시성 변경
    const visibilityDisposable = webviewView.onDidChangeVisibility(async () => {
      try {
        if (!webviewView.visible) {
          webviewView.webview.postMessage({ v: 1, type: 'ui.clearSelection' });
          return;
        }
        // 다시 보일 때는 버튼/상태 동기화
        const state = { ...this._state, logs: getBufferedLogs() };
        const panelState = await readEdgePanelState(this._context);
        webviewView.webview.postMessage({ v: 1, type: 'initState', payload: { state, panelState } });
        this._buttonHandler?.sendButtonSections();
        if (panelState.showExplorer) {
          await this._explorer?.refreshWorkspaceRoot();
        }
      } catch {}
    });
    this._trackDisposable(() => visibilityDisposable.dispose());

    // 활성 에디터가 바뀌면(에디터/커스텀 에디터/Diff 등) → 선택 해제
    const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
      try { webviewView.webview.postMessage({ v: 1, type: 'ui.clearSelection' }); } catch {}
    });
    this._trackDisposable(() => activeEditorDisposable.dispose());

    // 터미널 포커스 변화도 커버
    const activeTerminalDisposable = vscode.window.onDidChangeActiveTerminal(() => {
      try { webviewView.webview.postMessage({ v: 1, type: 'ui.clearSelection' }); } catch {}
    });
    this._trackDisposable(() => activeTerminalDisposable.dispose());

    // 창 포커스(윈도우) 상태 변화
    const winStateDisposable = vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) {
        try { webviewView.webview.postMessage({ v: 1, type: 'ui.clearSelection' }); } catch {}
      }
    });
    this._trackDisposable(() => winStateDisposable.dispose());

    // OutputChannel -> EdgePanel
    this._sink = (line: string) => {
      try { webviewView.webview.postMessage({ v: 1, type: 'appendLog', payload: { text: line } }); } catch {}
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

  /**
   * index.html 안의 상대 경로(href/src)를 전부 webview.asWebviewUri(...)로 치환
   */
  private async _getHtmlFromFiles(webview: vscode.Webview, mediaRoot: vscode.Uri): Promise<string> {
    const htmlPath = vscode.Uri.joinPath(mediaRoot, 'index.html');

    // 실제 배포 파일 경로
    const tokensCss = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'styles', 'tokens.css'));
    const baseCss = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'styles', 'base.css'));
    const layoutCss = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'styles', 'layout.css'));
    const componentsCss = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'styles', 'components.css'));
    const appJs = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'app.bundle.js'));

    const nonce = getNonce();
    const cspSource = webview.cspSource;

    let html = await readFileAsText(htmlPath);

    // CSP/nonce 치환
    html = html
      .replace(/%NONCE%/g, nonce)
      .replace(/%CSP_SOURCE%/g, cspSource);

    // 링크/스크립트 경로 치환
    html = html
      .replace(/href=["'](?:styles\/)?tokens\.css["']/g, `href="${String(tokensCss)}"`)
      .replace(/href=["'](?:styles\/)?base\.css["']/g, `href="${String(baseCss)}"`)
      .replace(/href=["'](?:styles\/)?layout\.css["']/g, `href="${String(layoutCss)}"`)
      .replace(/href=["'](?:styles\/)?components\.css["']/g, `href="${String(componentsCss)}"`)
      .replace(/src=["']app\.bundle\.js["']/g, `src="${String(appJs)}"`);

    return html;
  }
}

export function registerEdgePanelCommands(
  context: vscode.ExtensionContext,
  provider: EdgePanelProvider,
  perfMonitor?: PerfMonitor,
) {
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
