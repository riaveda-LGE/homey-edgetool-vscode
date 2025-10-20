// === src/extension/panels/extensionPanel.ts ===
import * as vscode from 'vscode';

import { readEdgePanelState, writeEdgePanelState, resolveWorkspaceInfo } from '../../core/config/userdata.js';
import {
  addLogSink,
  getLogger,
  removeLogSink,
} from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';
import {
  DEBUG_LOG_DIR,
  DEBUG_LOG_FILENAME,
  DEBUG_LOG_MEMORY_MAX,
  DEBUG_LOG_PAGE_SIZE,
  DEBUG_LOG_BIGFILE_BYTES,
  RAW_DIR_NAME,
  PANEL_VIEW_TYPE,
  RANDOM_STRING_LENGTH,
} from '../../shared/const.js';
import { readFileAsText } from '../../shared/utils.js';
import type { PerfMonitor } from '../editors/PerfMonitorEditorProvider.js';
import { EdgePanelActionRouter, type IEdgePanelActionRouter } from './EdgePanelActionRouter.js';
import { createExplorerBridge, type ExplorerBridge } from './explorerBridge.js';
import { LogViewerPanelManager } from './LogViewerPanelManager.js';
import * as fsp from 'fs/promises';

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

  // ── Debug Log Panel 스풀 상태 ───────────────────────────────────────
  private _dbgDir?: vscode.Uri;
  private _dbgFile?: vscode.Uri;
  private _dbgTotal = 0;     // 스풀 파일 기준 누적 라인 수
  private _dbgCursor = 0;    // 웹뷰 세션 기준 '이전 로드' 커서(끝에서 앞으로)
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

    // ── Debug Log 스풀 준비 및 초기 로그 로드 ───────────────────────
    await this._ensureDebugSpool();
    const initialLines = await this._readTail(DEBUG_LOG_MEMORY_MAX);
    this._state.logs = initialLines;
    // 커서는 파일 끝에서 현재 표시 라인수만큼 되돌린 위치
    this._dbgCursor = Math.max(0, this._dbgTotal - initialLines.length);

    // Explorer 브리지
    this._explorer = createExplorerBridge(this._context, (m) => {
      try {
        webviewView.webview.postMessage(m);
      } catch {}
    });

    // 로그 뷰어
    this._logViewer = new LogViewerPanelManager(this._context, this._extensionUri);

    // ── Debug Log sink 등록(한 번만) ─────────────────────────────────
    if (!this._sinkBound) {
      const sink = (line: string) => {
        try {
          webviewView.webview.postMessage({ v: 1, type: 'appendLog', payload: { text: line } });
        } catch {}
        // 파일 스풀(비동기, 비블로킹)
        this._appendToSpool(line).catch(() => {});
        this._dbgTotal += 1;
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
          // 메모리 버퍼 대신 스풀에서 읽은 tail(초기 로드) 사용
          const state = { ...this._state, logs: this._state.logs };
          webviewView.webview.postMessage({
            v: 1,
            type: 'initState',
            payload: { state, panelState },
          });
          webviewView.webview.postMessage({
            v: 1,
            type: 'setUpdateVisible',
            payload: { visible: !!(this._state.updateAvailable && this._state.updateUrl) },
          });
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

        // ── Webview 메시지 처리: Debug Log Panel 동작 ────────────────────
        if (msg?.type === 'debuglog.loadOlder' && msg?.v === 1) {
          // 커서 이전 구간에서 페이지 단위로 전송
          const limit: number = Number(msg?.payload?.limit ?? DEBUG_LOG_PAGE_SIZE);
          const end = this._dbgCursor; // [start, end) 형태로 생각
          const start = Math.max(0, end - limit);
          const lines = await this._readRange(start, end);
          this._dbgCursor = start;
          webviewView.webview.postMessage({
            v: 1,
            type: 'debuglog.page.response',
            payload: { lines, cursor: this._dbgCursor, total: this._dbgTotal },
          });
          return;
        }
        if (msg?.type === 'debuglog.clear' && msg?.v === 1) {
          await this._clearSpool();
          this._state.logs = [];
          this._dbgTotal = 0;
          this._dbgCursor = 0;
          webviewView.webview.postMessage({ v: 1, type: 'debuglog.cleared', payload: {} });
          return;
        }
        if (msg?.type === 'debuglog.copy' && msg?.v === 1) {
          const text = await this._readAllText();
          await vscode.env.clipboard.writeText(text);
          webviewView.webview.postMessage({
            v: 1,
            type: 'debuglog.copy.done',
            payload: { bytes: Buffer.byteLength(text, 'utf8'), lines: text ? text.split('\n').length : 0 },
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
          webviewView.webview.postMessage({ v: 1, type: 'ui.clearSelection' });
          return;
        }
        // 가시성 복귀 시에도 스풀 기반 상태 유지
        const state = { ...this._state, logs: this._state.logs };
        const panelState = await readEdgePanelState(this._context);
        webviewView.webview.postMessage({
          v: 1,
          type: 'initState',
          payload: { state, panelState },
        });
        this._actionRouter?.sendButtonSections();
        if (panelState.showExplorer) {
          await this._explorer?.refreshWorkspaceRoot();
        }
      } catch {}
    });
    this._trackDisposable(() => visibilityDisposable.dispose());

    const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
      try {
        webviewView.webview.postMessage({ v: 1, type: 'ui.clearSelection' });
      } catch {}
    });
    this._trackDisposable(() => activeEditorDisposable.dispose());

    const activeTerminalDisposable = vscode.window.onDidChangeActiveTerminal(() => {
      try {
        webviewView.webview.postMessage({ v: 1, type: 'ui.clearSelection' });
      } catch {}
    });
    this._trackDisposable(() => activeTerminalDisposable.dispose());

    const winStateDisposable = vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) {
        try {
          webviewView.webview.postMessage({ v: 1, type: 'ui.clearSelection' });
        } catch {}
      }
    });
    this._trackDisposable(() => winStateDisposable.dispose());

    webviewView.onDidDispose(() => {
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

  public async startRealtime(filter?: string) {
    this.log.debug('[debug] EdgePanelProvider startRealtime: start');
    await this._logViewer?.startRealtime(filter);
    this.log.debug('[debug] EdgePanelProvider startRealtime: end');
  }
  public async startFileMerge(dir: string) {
    this.log.debug('[debug] EdgePanelProvider startFileMerge: start');
    await this._logViewer?.startFileMerge(dir);
    this.log.debug('[debug] EdgePanelProvider startFileMerge: end');
  }
  public stopLogging() {
    this.log.debug('[debug] EdgePanelProvider stopLogging: start');
    this._logViewer?.stop();
    this.log.debug('[debug] EdgePanelProvider stopLogging: end');
  }

  // ───────────────────────────────────────────────────────────────────
  // Debug Log Spool Helpers
  // ───────────────────────────────────────────────────────────────────
  private async _ensureDebugSpool() {
    if (!this._dbgDir) {
      // 1) 워크스페이스가 있으면: <workspace>/<RAW_DIR_NAME>/<DEBUG_LOG_DIR>
      // 2) 없으면 폴백: <globalStorageUri>/<DEBUG_LOG_DIR>
      let dir: vscode.Uri | undefined;
      try {
        const info = await resolveWorkspaceInfo(this._context as any);
        if (info?.wsDirUri) {
          dir = vscode.Uri.joinPath(info.wsDirUri, RAW_DIR_NAME, DEBUG_LOG_DIR);
        }
      } catch {}
      if (!dir) {
        dir = vscode.Uri.joinPath(this._context.globalStorageUri, DEBUG_LOG_DIR);
      }
      await fsp.mkdir(dir.fsPath, { recursive: true });
      this._dbgDir = dir;
      this.log.debug(`[debug] spool dir fixed: ${dir.fsPath}`);
    }
    if (!this._dbgFile) {
      const file = vscode.Uri.joinPath(this._dbgDir, DEBUG_LOG_FILENAME);
      // 파일 존재 보장
      try {
        await fsp.access(file.fsPath);
      } catch {
        await fsp.writeFile(file.fsPath, '', 'utf8');
      }
      this._dbgFile = file;
      this.log.debug(`[debug] spool file: ${file.fsPath}`);
    }
    // 총 라인수 계산 (성능 보호: 큰 파일이면 전량 읽지 않음)
    try {
      const stat = await fsp.stat(this._dbgFile.fsPath);
      if (stat.size > DEBUG_LOG_BIGFILE_BYTES) {
        // 큰 파일: 정확 카운트는 생략하고 초기 tail만 사용하도록 둔다.
        // (_readTail 결과를 초기 상태로 쓰며, _dbgTotal은 우선 tail 길이로 설정)
        const tail = await this._readTail(DEBUG_LOG_MEMORY_MAX);
        this._dbgTotal = tail.length;
        this.log.debug(
          `[debug] large spool detected (${stat.size}B) → skip full count; init total≈${this._dbgTotal}`
        );
        return;
      }
    } catch {}
    try {
      const txt = await this._readAllText();
      this._dbgTotal = txt ? txt.split('\n').filter((l) => l.length > 0).length : 0;
    } catch {
      this._dbgTotal = 0;
    }
  }

  private async _appendToSpool(line: string) {
    if (!this._dbgFile) await this._ensureDebugSpool();
    try {
      await fsp.appendFile(this._dbgFile!.fsPath, line + '\n', 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        // 경로/파일이 사라졌다면 재보장 후 재시도
        await this._ensureDebugSpool();
        await fsp.appendFile(this._dbgFile!.fsPath, line + '\n', 'utf8');
      } else {
        throw err;
      }
    }
  }

  private async _readAllText(): Promise<string> {
    if (!this._dbgFile) await this._ensureDebugSpool();
    try {
      const buf = await fsp.readFile(this._dbgFile!.fsPath);
      return buf.toString('utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        // 경로/파일이 누락되었으면 재보장 후 재시도
        await this._ensureDebugSpool();
        try {
          const buf = await fsp.readFile(this._dbgFile!.fsPath);
          return buf.toString('utf8');
        } catch {
          return '';
        }
      }
      throw err;
    }
  }

  private async _readTail(n: number): Promise<string[]> {
    const all = await this._readAllText();
    if (!all) return [];
    const lines = all.split('\n').filter((l) => l.length > 0);
    return lines.slice(-n);
  }

  private async _readRange(start: number, end: number): Promise<string[]> {
    const all = await this._readAllText();
    if (!all) return [];
    const lines = all.split('\n').filter((l) => l.length > 0);
    const s = Math.max(0, Math.min(start, lines.length));
    const e = Math.max(0, Math.min(end, lines.length));
    if (s >= e) return [];
    return lines.slice(s, e);
  }

  private async _clearSpool() {
    if (!this._dbgFile) await this._ensureDebugSpool();
    try {
      await fsp.unlink(this._dbgFile!.fsPath);
    } catch {}
    // 디렉터리가 사라졌을 수도 있으니 재보장 후 빈 파일 생성
    await this._ensureDebugSpool();
    await fsp.writeFile(this._dbgFile!.fsPath, '', 'utf8');
  }

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
