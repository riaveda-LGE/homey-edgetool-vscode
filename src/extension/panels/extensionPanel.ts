// === src/extension/panels/extensionPanel.ts ===
import * as fs from 'fs';
import * as vscode from 'vscode';

import { downloadAndInstall } from '../update/updater.js';
import { addLogSink, getBufferedLogs, getLogger, removeLogSink } from '../../core/logging/extension-logger.js';
import { PANEL_VIEW_TYPE, READY_MARKER } from '../../shared/const.js';

// 세션/브리지 스텁
import { LogSessionManager } from '../../core/sessions/LogSessionManager.js';
import { HostWebviewBridge } from '../messaging/hostWebviewBridge.js';

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
  private _bridge?: HostWebviewBridge;
  private _currentAbort?: AbortController;

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

    // 보안상 필요한 dist 폴더만 허용
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'dist', 'ui', 'edge-panel'),
      ],
      ...({ retainContextWhenHidden: true } as any),
    };

    webviewView.title = `Edge Console - v${this._state.version}`;
    webviewView.webview.html = this._getHtmlFromFiles(webviewView.webview);

    try {
      this._bridge = new HostWebviewBridge(webviewView);
      this._bridge.start();
    } catch {}

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg?.command === 'run') {
          const text = String(msg.text ?? '').trim();
          this.log.info(`edge> ${text}`);

          if (text === 'homey-logging') {
            this._session?.stopAll();
            this._currentAbort?.abort();

            this._session = new LogSessionManager();
            this._currentAbort = new AbortController();

            this._session.startRealtimeSession({
              signal: this._currentAbort.signal,
              onBatch: (logs, total, seq) => {
                for (const l of logs) this.appendLog(`[LOG][${l.type}] ${l.text}`);
              },
              onMetrics: (m) => {
                this.appendLog(`[metrics] ${JSON.stringify(m.buffer)}`);
              },
            });
            this.appendLog('[info] realtime logging session started (stub)');

          } else if (text.startsWith('homey-logging --dir ')) {
            const dir = text.replace('homey-logging --dir', '').trim();
            if (!dir) { this.appendLog('[error] directory path required'); return; }

            this._session?.stopAll();
            this._currentAbort?.abort();

            this._session = new LogSessionManager();
            this._currentAbort = new AbortController();

            this._session.startFileMergeSession({
              dir,
              signal: this._currentAbort.signal,
              onBatch: (logs, total, seq) => {
                for (const l of logs) this.appendLog(`[MERGE][${l.type}] ${l.text}`);
              },
              onMetrics: (m) => {
                this.appendLog(`[metrics] ${JSON.stringify(m.buffer)}`);
              },
            });
            this.appendLog(`[info] file-merge logging session started (dir=${dir}, stub)`);

          } else if (text === 'homey-logging --stop') {
            this._session?.stopAll();
            this._currentAbort?.abort();
            this.appendLog('[info] logging session stopped');

          } else {
            this.log.info(`edge> passthrough: ${text}`);
          }

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
        this.log.error('onDidReceiveMessage error', e);
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) return;
      try {
        const state = { ...this._state, logs: getBufferedLogs() };
        webviewView.webview.postMessage({ type: 'initState', state });
      } catch {}
    });

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

  private _getHtmlFromFiles(webview: vscode.Webview): string {
    // dist/ui/edge-panel 에 복사된 정적 리소스를 사용
    const root = vscode.Uri.joinPath(this._extensionUri, 'dist', 'ui', 'edge-panel');
    const htmlPath = vscode.Uri.joinPath(root, 'index.html');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(root, 'panel.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(root, 'panel.js'));

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
