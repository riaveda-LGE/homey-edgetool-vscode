// === src/extension/panels/EdgePanelLogViewer.ts ===
import * as vscode from 'vscode';
import { readFileAsText } from '../../shared/utils.js';
import { LogSessionManager } from '../../core/sessions/LogSessionManager.js';
import { RANDOM_STRING_LENGTH } from '../../shared/const.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import type { LogEntry } from '../messaging/messageTypes.js';
import type { HostConfig } from '../../core/connection/ConnectionManager.js';
import { EdgePanelConnectionManager } from './EdgePanelConnectionManager.js';

export class EdgePanelLogViewer {
  private _logPanel?: vscode.WebviewPanel;
  private _session?: LogSessionManager;
  private _currentAbort?: AbortController;
  private _connectionManager: EdgePanelConnectionManager;

  constructor(
    private _context: vscode.ExtensionContext,
    private _extensionUri: vscode.Uri,
    private _appendLog: (line: string) => void
  ) {
    this._connectionManager = new EdgePanelConnectionManager(_context);
  }

  async handleHomeyLoggingCommand() {
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
      this._session?.stopAll();
      this._currentAbort?.abort();

      const conn = await this._connectionManager.pickConnection();
      if (!conn) {
        viewer.webview.postMessage({
          v: 1,
          type: 'logs.batch',
          payload: {
            logs: [
              { id: Date.now(), ts: Date.now(), text: '실시간 로그를 시작할 수 없습니다 (연결 정보 없음).' },
            ],
            seq: 1,
          },
        });
        return;
      }

      this._session = new LogSessionManager(conn);
      this._currentAbort = new AbortController();

      let seq = 0;
      await this._session.startRealtimeSession({
        signal: this._currentAbort.signal,
        onBatch: (logs: LogEntry[]) => {
          viewer.webview.postMessage({
            v: 1,
            type: 'logs.batch',
            payload: { logs, seq: ++seq },
          });
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
      });
    }
  }

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
    let html = await readFileAsText(htmlPath);
    html = html.replace(/%NONCE%/g, getNonce()).replace(/%CSP_SOURCE%/g, panel.webview.cspSource);
    panel.webview.html = html;

    panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.v === 1 && msg?.type === 'ui.log') {
        const lvl = String(msg.payload?.level ?? 'info') as 'debug' | 'info' | 'warn' | 'error';
        const text = String(msg.payload?.text ?? '');
        const src = String(msg.payload?.source ?? 'ui.logViewer');
        const lg = getLogger(src);
        (lg[lvl] ?? lg.info).call(lg, text);
      }
    });

    panel.onDidDispose(() => { this._logPanel = undefined; });
    this._logPanel = panel;
    return panel;
  }

  dispose() {
    this._session?.stopAll();
    this._currentAbort?.abort();
    this._session = undefined;
    this._currentAbort = undefined;
    if (this._logPanel) {
      this._logPanel.dispose();
      this._logPanel = undefined;
    }
  }
}

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < RANDOM_STRING_LENGTH; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
