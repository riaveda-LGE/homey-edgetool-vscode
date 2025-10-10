// === src/extension/panels/extensionPanel.ts ===
import * as fs from 'fs';
import * as vscode from 'vscode';

import {
  addLogSink,
  getBufferedLogs,
  getLogger,
  removeLogSink,
} from '../../core/logging/extension-logger.js';
import { LogSessionManager } from '../../core/sessions/LogSessionManager.js';
import { PANEL_VIEW_TYPE, READY_MARKER } from '../../shared/const.js';
import type { LogEntry } from '../messaging/messageTypes.js';
import { downloadAndInstall } from '../update/updater.js';

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

  private _session?: LogSessionManager;
  private _currentAbort?: AbortController;

  // 커스텀 로그 뷰어 패널 핸들
  private _logPanel?: vscode.WebviewPanel;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    version: string,
    latestInfo?: { hasUpdate?: boolean; latest?: string; url?: string; sha256?: string },
  ) {
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

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;

    // 🔧 빌드 산출물 경로로 교체
    const uiRoot = vscode.Uri.joinPath(this._extensionUri, 'dist', 'ui', 'edge-panel');

    webviewView.webview.options = {
      enableScripts: true,
      // 🔧 웹뷰가 읽을 수 있는 로컬 리소스 루트 지정
      localResourceRoots: [uiRoot],
      ...({ retainContextWhenHidden: true } as any),
    };

    webviewView.title = `Edge Console - v${this._state.version}`;

    try {
      webviewView.webview.html = this._getHtmlFromFiles(webviewView.webview, uiRoot);
    } catch (e: any) {
      const msg = `Failed to load panel HTML: ${e?.message || e}`;
      this.log.error(msg);
      vscode.window.showErrorMessage(msg);
      // 최소한의 에러 페이지
      webviewView.webview.html = `<html><body style="color:#ddd;background:#1e1e1e;font-family:ui-monospace,Consolas,monospace;padding:12px">
        <h3>Edge Console</h3>
        <pre>${msg}</pre>
      </body></html>`;
      // 더 진행해도 의미 없으니 리턴
      return;
    }

    // webview → extension
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg?.command === 'run') {
          const text = String(msg.text ?? '').trim();
          this.log.info(`edge> ${text}`);

          if (text === 'homey-logging') {
            await this.handleHomeyLoggingCommand();
            return;
          }
          this.log.info(`edge> passthrough: ${text}`);
        } else if (msg?.command === 'ready') {
          this._state.logs = getBufferedLogs();
          webviewView.webview.postMessage({ type: 'initState', state: this._state });
          webviewView.webview.postMessage({
            type: 'setUpdateVisible',
            visible: !!(this._state.updateAvailable && this._state.updateUrl),
          });
          this.appendLog(`${READY_MARKER} Ready. Type a command after "edge>" and hit Enter.`);
        } else if (msg?.command === 'versionUpdate') {
          if (!this._state.updateUrl) {
            this.appendLog('[update] 최신 버전 URL이 없습니다.');
            return;
          }
          this.appendLog('[update] 업데이트를 시작합니다...');
          await downloadAndInstall(
            this._state.updateUrl,
            (line) => this.appendLog(line),
            this._state.latestSha,
          );
        } else if (msg?.command === 'reloadWindow') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } catch (e) {
        this.log.error('onDidReceiveMessage error', e as any);
      }
    });

    // 가시성 변화마다 버퍼 재주입
    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) return;
      try {
        const state = { ...this._state, logs: getBufferedLogs() };
        webviewView.webview.postMessage({ type: 'initState', state });
      } catch {}
    });

    // OutputChannel → EdgePanel
    this._sink = (line: string) => {
      try {
        webviewView.webview.postMessage({ type: 'appendLog', text: line });
      } catch {}
    };
    addLogSink(this._sink);

    webviewView.onDidDispose(() => {
      if (this._sink) removeLogSink(this._sink);
      this._sink = undefined;

      this._session?.stopAll();
      this._currentAbort?.abort();
      this._session = undefined;
      this._currentAbort = undefined;

      this._view = undefined;
    });
  }

  // homey-logging 처리
  private async handleHomeyLoggingCommand() {
    const pick = await vscode.window.showQuickPick(
      [
        { label: '실시간 로그 모드', value: 'realtime' },
        { label: '파일 병합 모드', value: 'filemerge' },
      ],
      { placeHolder: 'Homey Logging 모드를 선택하세요' },
    );
    if (!pick) return;

    const viewer = await this.openLogViewerPanel();

    if (pick.value === 'realtime') {
      viewer.webview.postMessage({
        v: 1,
        type: 'logs.batch',
        payload: {
          logs: [
            {
              id: Date.now(),
              ts: Date.now(),
              text: '기기가 연결되어 있지 않습니다. (실시간 로그 모드)',
            },
          ],
          seq: 1,
        },
      });
      return;
    }

    if (pick.value === 'filemerge') {
      const dirPick = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: '로그 폴더 선택',
      });
      if (!dirPick || dirPick.length === 0) return;
      const dir = dirPick[0].fsPath;

      this._session?.stopAll();
      this._currentAbort?.abort();

      this._session = new LogSessionManager();
      this._currentAbort = new AbortController();

      let seq = 0;
      await this._session.startFileMergeSession({
        dir,
        signal: this._currentAbort.signal,
        onBatch: (logs: LogEntry[], total?: number) => {
          viewer.webview.postMessage({
            v: 1,
            type: 'logs.batch',
            payload: { logs, total, seq: ++seq },
          });
        },
        onMetrics: (m: { buffer: any; mem: { rss: number; heapUsed: number } }) => {
          viewer.webview.postMessage({
            v: 1,
            type: 'metrics.update',
            payload: m,
          });
        },
      });
    }
  }

  // 커스텀 로그 뷰어 열기/재사용
  private async openLogViewerPanel(): Promise<vscode.WebviewPanel> {
    if (this._logPanel) {
      try {
        this._logPanel.reveal(vscode.ViewColumn.Active);
        return this._logPanel;
      } catch {
        this._logPanel = undefined;
      }
    }

    const panel = vscode.window.createWebviewPanel(
      'homeyLogViewer',
      'Homey Log Viewer',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'ui', 'log-viewer')],
      },
    );

    const mediaRoot = vscode.Uri.joinPath(this._extensionUri, 'dist', 'ui', 'log-viewer');
    const htmlPath = vscode.Uri.joinPath(mediaRoot, 'index.html');
    let html = (await vscode.workspace.fs.readFile(htmlPath)).toString();
    html = html.replace(/%NONCE%/g, getNonce()).replace(/%CSP_SOURCE%/g, panel.webview.cspSource);
    panel.webview.html = html;

    panel.onDidDispose(() => {
      this._logPanel = undefined;
    });

    this._logPanel = panel;
    return panel;
  }

  private _getHtmlFromFiles(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const htmlPath = vscode.Uri.joinPath(mediaRoot, 'index.html');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.js'));

    const nonce = getNonce();
    const cspSource = webview.cspSource;

    let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
    html = html
      .replace(/%CSS_URI%/g, String(cssUri))
      .replace(/%JS_URI%/g, String(jsUri))
      .replace(/%NONCE%/g, nonce)
      .replace(/%CSP_SOURCE%/g, cspSource);

    return html;
  }
}

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
