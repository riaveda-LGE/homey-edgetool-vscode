// === src/extension/panels/extensionPanel.ts ===
import * as vscode from 'vscode';

import { readEdgePanelState, writeEdgePanelState } from '../../core/config/userdata.js';
import {
  addLogSink,
  getBufferedLogs,
  getLogger,
  removeLogSink,
} from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';
import { PANEL_VIEW_TYPE, RANDOM_STRING_LENGTH } from '../../shared/const.js';
import { readFileAsText } from '../../shared/utils.js';
import type { PerfMonitor } from '../editors/PerfMonitorEditorProvider.js';
import { EdgePanelActionRouter, type IEdgePanelActionRouter } from './EdgePanelActionRouter.js';
import { createExplorerBridge, type ExplorerBridge } from './explorerBridge.js';
import { LogViewerPanelManager } from './LogViewerPanelManager.js';

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
  private _actionRouter?: IEdgePanelActionRouter;
  private _logViewer?: LogViewerPanelManager;

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
      localResourceRoots: [uiRoot],
      // @ts-expect-error retainContextWhenHidden is supported but not typed
      retainContextWhenHidden: true,
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

    // 로그 뷰어
    this._logViewer = new LogViewerPanelManager(
      this._context,
      this._extensionUri,
      (line) => this.appendLog(line)
    );

    // 버튼 실행 라우터(ActionRouter)
    this._actionRouter = new EdgePanelActionRouter(
      webviewView,
      this._context,
      this._extensionUri,
      (line) => this.appendLog(line),
      {
        updateAvailable: this._state.updateAvailable,
        updateUrl: this._state.updateUrl,
        latestSha: this._state.latestSha
      },
      this,
      this._perfMonitor,
      this._explorer
    );

    // Webview → Extension
    const messageDisposable = webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (this._explorer && (await this._explorer.handleMessage(msg))) return;

        if (msg?.type === 'workspace.ensure' && msg?.v === 1) {
          await this._explorer?.refreshWorkspaceRoot();
          return;
        }

        if (msg?.type === 'ui.requestButtons' && msg?.v === 1) {
          this._actionRouter?.sendButtonSections();
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
          const panelState = await readEdgePanelState(this._context);
          const state = { ...this._state, logs: getBufferedLogs() };
          webviewView.webview.postMessage({ v: 1, type: 'initState', payload: { state, panelState } });
          webviewView.webview.postMessage({ v: 1, type: 'setUpdateVisible', payload: { visible: !!(this._state.updateAvailable && this._state.updateUrl) } });
          this._actionRouter?.sendButtonSections();

          if (panelState.showExplorer) {
            await this._explorer?.refreshWorkspaceRoot();
          }
          return;
        } else if (msg?.type === 'ui.savePanelState' && msg?.v === 1) {
          await writeEdgePanelState(this._context, msg.payload.panelState);
          return;
        } else if (msg?.command === 'reloadWindow') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
          return;
        } else if (msg?.type === 'button.click' && msg?.v === 1 && typeof msg.payload.id === 'string') {
          await this._actionRouter?.dispatchButton(msg.payload.id);
          return;
        }

        // ====== 로그 뷰어 위임 ======
        if (msg?.type === 'logging.startRealtime' && msg?.v === 1) {
          await this._logViewer?.startRealtime(msg.payload?.filter);
          return;
        }
        if (msg?.type === 'logging.startFileMerge' && msg?.v === 1) {
          const dir = String(msg.payload?.dir || '');
          if (!dir) {
            vscode.window.showWarningMessage('병합할 로그 디렉터리가 지정되지 않았습니다.');
            return;
          }
          await this._logViewer?.startFileMerge(dir);
          return;
        }
        if (msg?.type === 'logging.stop' && msg?.v === 1) {
          this._logViewer?.stop();
          return;
        }
      } catch (e) {
        this.log.error('onDidReceiveMessage error', e as any);
      }
    });
    this._trackDisposable(() => messageDisposable.dispose());

    const visibilityDisposable = webviewView.onDidChangeVisibility(async () => {
      try {
        if (!webviewView.visible) {
          webviewView.webview.postMessage({ v: 1, type: 'ui.clearSelection' });
          return;
        }
        const state = { ...this._state, logs: getBufferedLogs() };
        const panelState = await readEdgePanelState(this._context);
        webviewView.webview.postMessage({ v: 1, type: 'initState', payload: { state, panelState } });
        this._actionRouter?.sendButtonSections();
        if (panelState.showExplorer) {
          await this._explorer?.refreshWorkspaceRoot();
        }
      } catch {}
    });
    this._trackDisposable(() => visibilityDisposable.dispose());

    const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
      try { webviewView.webview.postMessage({ v: 1, type: 'ui.clearSelection' }); } catch {}
    });
    this._trackDisposable(() => activeEditorDisposable.dispose());

    const activeTerminalDisposable = vscode.window.onDidChangeActiveTerminal(() => {
      try { webviewView.webview.postMessage({ v: 1, type: 'ui.clearSelection' }); } catch {}
    });
    this._trackDisposable(() => activeTerminalDisposable.dispose());

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

      this._actionRouter?.dispose();
      this._actionRouter = undefined;

      this._logViewer?.dispose();
      this._logViewer = undefined;

      this._view = undefined;
    });
  }

  @measure()
  public async handleHomeyLoggingCommand() {
    await this._logViewer?.handleHomeyLoggingCommand();
  }

  public async startRealtime(filter?: string) {
    await this._logViewer?.startRealtime(filter);
  }
  public async startFileMerge(dir: string) {
    await this._logViewer?.startFileMerge(dir);
  }
  public stopLogging() {
    this._logViewer?.stop();
  }

  private _randomNonce(len = (RANDOM_STRING_LENGTH || 32)) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < len; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
  }

  /**
   * index.html을 읽어:
   *  - %CSP_SOURCE% → webview.cspSource
   *  - %NONCE%      → 생성된 nonce
   *  - src/href의 로컬 상대경로 → webview.asWebviewUri(...)로 재작성
   *  - 모든 <script> 태그에 nonce 속성 자동 주입(기존에 없을 때만)
   */
  private async _getHtmlFromFiles(webview: vscode.Webview, root: vscode.Uri) {
    try {
      const indexHtml = vscode.Uri.joinPath(root, 'index.html');
      let html = await readFileAsText(indexHtml);

      // 1) CSP 치환
      const nonce = this._randomNonce();
      html = html.replace(/%CSP_SOURCE%/g, webview.cspSource);
      html = html.replace(/%NONCE%/g, nonce);

      // 2) 리소스 경로 재작성(src/href)
      const ATTR_RE = /(<(script|link|img)\b[^>]*?\s(?:src|href)=)(['"])([^'"]+)\3/gi;
      html = html.replace(ATTR_RE, (_m, p1: string, _tag: string, q: string, url: string) => {
        const lower = url.toLowerCase();
        const isAbs =
          lower.startsWith('http:') ||
          lower.startsWith('https:') ||
          lower.startsWith('data:') ||
          lower.startsWith('blob:') ||
          lower.startsWith('vscode-webview:') ||
          lower.startsWith('vscode-resource:') ||
          lower.startsWith('chrome:') ||
          lower.startsWith('about:') ||
          lower.startsWith('#') ||
          lower.startsWith('//');
        if (isAbs) return `${p1}${q}${url}${q}`;
        const rewritten = webview.asWebviewUri(vscode.Uri.joinPath(root, url)).toString();
        return `${p1}${q}${rewritten}${q}`;
      });

      // 3) <script> nonce 자동 주입 (이미 nonce가 있으면 유지)
      html = html.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);

      return html;
    } catch (e) {
      return `<html><body><pre>Edge Panel UI missing</pre></body></html>`;
    }
  }
}

// ⬇️ 명령 등록 (QuickPick 포함)
export function registerEdgePanelCommands(context: vscode.ExtensionContext, provider: EdgePanelProvider) {
  const regs = [
    // QuickPick으로 모드 선택
    vscode.commands.registerCommand('homey.logging.openViewer', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(debug-start) 실시간 로그 보기', description: 'ADB / journalctl 스트리밍', id: 'realtime' },
          { label: '$(folder) 파일 병합 보기', description: '폴더 로그 병합 + 페이징', id: 'filemerge' },
        ],
        {
          title: 'Homey Log Viewer - 모드 선택',
          placeHolder: '모드를 선택하세요',
          ignoreFocusOut: true,
          canPickMany: false,
        },
      );
      if (!pick) return;

      if (pick.id === 'realtime') {
        const filter = await vscode.window.showInputBox({
          title: '실시간 로그 필터 (선택)',
          prompt: '포함될 문자열(공란=전체)',
          placeHolder: '(예) homey | ERROR',
          ignoreFocusOut: true,
        });
        await provider.startRealtime(filter);
        return;
      }

      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: '병합할 로그 디렉터리를 선택하세요',
      });
      if (picked && picked[0]) {
        await provider.startFileMerge(picked[0].fsPath);
      }
    }),

    vscode.commands.registerCommand('homey.logging.startRealtime', (filter?: string) => provider.startRealtime(filter)),

    vscode.commands.registerCommand('homey.logging.startFileMerge', async (dir?: string) => {
      if (dir && typeof dir === 'string') {
        await provider.startFileMerge(dir);
        return;
      }
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: '병합할 로그 디렉터리를 선택하세요',
      });
      if (picked && picked[0]) {
        await provider.startFileMerge(picked[0].fsPath);
      }
    }),

    vscode.commands.registerCommand('homey.logging.stop', () => provider.stopLogging()),
  ];
  regs.forEach(d => context.subscriptions.push(d));
}
