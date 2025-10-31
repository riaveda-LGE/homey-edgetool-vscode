// === src/extension/panels/extensionPanel.ts ===
import * as vscode from 'vscode';

import {
  readEdgePanelState,
  resolveWorkspaceInfo,
  writeEdgePanelState,
} from '../../core/config/userdata.js';
import { getStatusLiteFromDir } from '../../core/controller/GitController.js';
import {
  addLogSink,
  getLogger,
  removeLogSink,
  setWebviewReady,
} from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';
import { DEBUG_LOG_MEMORY_MAX, PANEL_VIEW_TYPE, RANDOM_STRING_LENGTH } from '../../shared/const.js';
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

  // ── Debug Log Panel: 메모리 링버퍼(최대 DEBUG_LOG_MEMORY_MAX줄) ─────
  private _ring: string[] = [];
  private _sinkBound = false;

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
      logs: [], // 초기에는 스풀에서 tail 로 채움
    };
  }

  private _trackDisposable(disposable: () => void) {
    this._disposables.add(disposable);
  }
  private _disposeTracked() {
    for (const dispose of this._disposables) {
      try {
        dispose();
      } catch (e) {
        this.log.warn(`dispose error: ${e}`);
      }
    }
    this._disposables.clear();
  }

  @measure()
  async resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;

    // 단일 송신 경로(후속 스로틀/로깅을 위해 postMessage 직접 호출 금지)
    const sendEdge = (m: any) => {
      try {
        webviewView.webview.postMessage(m);
      } catch {}
    };

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

    // ── Debug Log: 링버퍼 현재 상태로 초기 로드 ───────────────────────
    this._state.logs = this._ring.slice(-DEBUG_LOG_MEMORY_MAX);

    // Explorer 브리지
    this._explorer = createExplorerBridge(this._context, (m) => sendEdge(m));

    // 로그 뷰어
    this._logViewer = new LogViewerPanelManager(this._context, this._extensionUri);

    // ── Debug Log sink 등록(한 번만) ─────────────────────────────────
    if (!this._sinkBound) {
      // 50ms 마이크로 배치(로그 폭주 시 렌더 부하 완화)
      const pending: string[] = [];
      let t: NodeJS.Timeout | null = null;
      const flush = () => {
        const lines = pending.splice(0, pending.length);
        for (const ln of lines) {
          sendEdge({ v: 1, type: 'appendLog', payload: { text: ln } });
        }
        t = null;
      };
      const sink = (line: string) => {
        try {
          pending.push(line);
          if (!t) t = setTimeout(flush, 50);
        } catch {}
        // 메모리 링버퍼 유지 (최대 DEBUG_LOG_MEMORY_MAX줄)
        this._ring.push(line);
        if (this._ring.length > DEBUG_LOG_MEMORY_MAX) {
          this._ring.splice(0, this._ring.length - DEBUG_LOG_MEMORY_MAX);
        }
        // 최신 상태를 상태 객체에도 반영(다음 initState 대비)
        this._state.logs = this._ring.slice(-DEBUG_LOG_MEMORY_MAX);
      };
      addLogSink(sink);
      this._sink = sink;
      this._sinkBound = true;
      this._trackDisposable(() => removeLogSink(sink));
    }

    // 버튼 실행 라우터(ActionRouter)
    this._actionRouter = new EdgePanelActionRouter(
      webviewView,
      this._context,
      this._extensionUri,
      {
        updateAvailable: this._state.updateAvailable,
        updateUrl: this._state.updateUrl,
        latestSha: this._state.latestSha,
      },
      this,
      this._perfMonitor,
      this._explorer,
    );

    // initState/버튼 섹션 전송의 중복 방지(예: ui.ready 직후 가시성 변동)
    let _lastInitSentAt = 0;
    const sendInitIfNotRecent = async (reason: string) => {
      const now = Date.now();
      if (now - _lastInitSentAt < 300) return null;
      _lastInitSentAt = now;
      const panelState = await readEdgePanelState(this._context);
      const state = { ...this._state, logs: this._ring.slice(-DEBUG_LOG_MEMORY_MAX) };
      sendEdge({ v: 1, type: 'initState', payload: { state, panelState } });
      sendEdge({
        v: 1,
        type: 'setUpdateVisible',
        payload: { visible: !!(this._state.updateAvailable && this._state.updateUrl) },
      });
      this._actionRouter?.sendButtonSections();
      return panelState;
    };

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
        // ── Git 상태 요청 처리 ─────────────────────────────────────────
        if (msg?.type === 'git.status.request' && msg?.v === 1) {
          try {
            const info = await resolveWorkspaceInfo(this._context);
            const status = await getStatusLiteFromDir(info.wsDirFsPath);
            sendEdge({ v: 1, type: 'git.status.response', payload: { status } });
          } catch (e: any) {
            const m = e?.message || String(e);
            this.log.warn(`git.status.request failed: ${m}`);
            sendEdge({ v: 1, type: 'git.status.error', payload: { message: m } });
          }
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
          setWebviewReady(true);
          const panelState = await sendInitIfNotRecent('ui.ready');

          if (panelState?.showExplorer) {
            await this._explorer?.refreshWorkspaceRoot();
          }
          return;
        } else if (msg?.type === 'ui.savePanelState' && msg?.v === 1) {
          await writeEdgePanelState(this._context, msg.payload.panelState);
          return;
        } else if (msg?.command === 'reloadWindow') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
          return;
        } else if (
          msg?.type === 'button.click' &&
          msg?.v === 1 &&
          typeof msg.payload.id === 'string'
        ) {
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

        // ── Webview 메시지 처리: Debug Log Panel (메모리 링버퍼) ──────────
        if (msg?.type === 'debuglog.clear' && msg?.v === 1) {
          this._ring = [];
          this._state.logs = [];
          sendEdge({ v: 1, type: 'debuglog.cleared', payload: {} });
          return;
        }
        if (msg?.type === 'debuglog.copy' && msg?.v === 1) {
          const text = this._ring.join('\n');
          await vscode.env.clipboard.writeText(text);
          sendEdge({
            v: 1,
            type: 'debuglog.copy.done',
            payload: { bytes: Buffer.byteLength(text, 'utf8'), lines: this._ring.length },
          });
          vscode.window.showInformationMessage('Debug logs copied to clipboard.');
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
          sendEdge({ v: 1, type: 'ui.clearSelection' });
          return;
        }
        // 가시성 복귀 시에도 스풀 기반 상태 유지 + 중복 가드
        const panelState = await sendInitIfNotRecent('visibility');
        if (panelState?.showExplorer) {
          await this._explorer?.refreshWorkspaceRoot();
        }
      } catch {}
    });
    this._trackDisposable(() => visibilityDisposable.dispose());

    const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
      try {
        sendEdge({ v: 1, type: 'ui.clearSelection' });
      } catch {}
    });
    this._trackDisposable(() => activeEditorDisposable.dispose());

    const activeTerminalDisposable = vscode.window.onDidChangeActiveTerminal(() => {
      try {
        sendEdge({ v: 1, type: 'ui.clearSelection' });
      } catch {}
    });
    this._trackDisposable(() => activeTerminalDisposable.dispose());

    const winStateDisposable = vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) {
        try {
          sendEdge({ v: 1, type: 'ui.clearSelection' });
        } catch {}
      }
    });
    this._trackDisposable(() => winStateDisposable.dispose());

    webviewView.onDidDispose(() => {
      setWebviewReady(false);
      this._disposeTracked();

      if (this._sink) removeLogSink(this._sink);
      this._sink = undefined;

      try {
        this._explorer?.dispose();
      } catch {}
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
    this.log.debug('[debug] EdgePanelProvider handleHomeyLoggingCommand: start');
    await this._logViewer?.handleHomeyLoggingCommand();
    this.log.debug('[debug] EdgePanelProvider handleHomeyLoggingCommand: end');
  }

  @measure()
  public async startRealtime(filter?: string) {
    this.log.debug('[debug] EdgePanelProvider startRealtime: start');
    await this._logViewer?.startRealtime(filter);
    this.log.debug('[debug] EdgePanelProvider startRealtime: end');
  }
  @measure()
  public async startFileMerge(dir: string) {
    await this._logViewer?.startFileMerge(dir);
  }
  public stopLogging() {
    this._logViewer?.stop();
  }

  @measure()
  private _randomNonce(len = RANDOM_STRING_LENGTH || 32) {
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
  @measure()
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
export function registerEdgePanelCommands(
  context: vscode.ExtensionContext,
  provider: EdgePanelProvider,
) {
  const regs = [
    // QuickPick으로 모드 선택
    vscode.commands.registerCommand('homey.logging.openViewer', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: '$(debug-start) 실시간 로그 보기',
            description: 'ADB / journalctl 스트리밍',
            id: 'realtime',
          },
          {
            label: '$(folder) 파일 병합 보기',
            description: '폴더 로그 병합 + 페이징',
            id: 'filemerge',
          },
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

    vscode.commands.registerCommand('homey.logging.startRealtime', (filter?: string) =>
      provider.startRealtime(filter),
    ),

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
  regs.forEach((d) => context.subscriptions.push(d));
}
