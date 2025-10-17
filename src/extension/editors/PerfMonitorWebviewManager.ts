// === src/extension/editors/PerfMonitorWebviewManager.ts ===
import * as vscode from 'vscode';
import type { IPerfMonitorDataManager } from './IPerfMonitorComponents.js';

export class PerfMonitorWebviewManager {
  private _webviewPanel: vscode.WebviewPanel | null = null;
  private _disposables = new Set<() => void>();

  constructor(
    private _dataManager: IPerfMonitorDataManager,
    private _extensionUri: vscode.Uri,
  ) {}

  private _trackDisposable(disposable: vscode.Disposable) {
    this._disposables.add(() => disposable.dispose());
  }

  createPanel(): void {
    if (this._webviewPanel) {
      this._webviewPanel.reveal(vscode.ViewColumn.One);
      return;
    }

    this._webviewPanel = vscode.window.createWebviewPanel(
      'homeyPerfMonitor',
      'Homey Performance Monitor',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'webviewers', 'perf-monitor')],
      },
    );

    this._webviewPanel.webview.html = this.getHtml(this._webviewPanel.webview);

    this._trackDisposable(
      this._webviewPanel.webview.onDidReceiveMessage((msg) => {
        if (msg.type === 'perf.ready') {
          this.sendInitialData();
        }
      }),
    );

    this._trackDisposable(
      this._webviewPanel.onDidDispose(() => {
        this._webviewPanel = null;
      }),
    );
  }

  closePanel(): void {
    if (this._webviewPanel) {
      this._webviewPanel.dispose();
      this._webviewPanel = null;
    }
  }

  updatePanel(): void {
    if (this._webviewPanel && this._dataManager.isPerfMode()) {
      const data = this._dataManager.getPerfData();
      data.forEach((item) => {
        this._webviewPanel!.webview.postMessage({ v: 1, type: 'perf.updateData', payload: { data: item } });
      });
    }
  }

  dispose(): void {
    this.closePanel();
    for (const dispose of this._disposables) {
      dispose();
    }
    this._disposables.clear();
  }

  private sendInitialData(): void {
    const data = this._dataManager.getPerfData();
    if (data.length > 0) {
      data.forEach((item) => {
        this._webviewPanel?.webview.postMessage({ v: 1, type: 'perf.updateData', payload: { data: item } });
      });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    // ✅ 실제 산출물 파일명과 일치
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webviewers', 'perf-monitor', 'app.bundle.js')
    );
    // ✅ 외부 CSS 링크 추가
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webviewers', 'perf-monitor', 'style.css')
    );

    const cspSource = webview.cspSource;

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}'; img-src ${cspSource} data:;">
        <title>Homey EdgeTool Performance Monitor</title>
        <link rel="stylesheet" href="${styleUri}">
        <style>
          /* 기본 VS Code 테마 변수 기반의 최소 레이아웃 보정 (외부 CSS가 핵심 스타일 담당) */
          body {
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            margin: 0;
            padding: 20px;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>🚀 Homey EdgeTool Performance Monitor</h1>
          <p>Real-time CPU, Memory, and Operation Analysis</p>
        </div>

        <div id="chart" class="chart-container" style="margin-bottom: 20px;"></div>

        <div class="metrics">
          <div class="metric-card">
            <div class="metric-title">CPU Usage</div>
            <div class="metric-value" id="cpuValue">-- ms</div>
            <div class="metric-list" id="cpuList">No data yet</div>
          </div>

          <div class="metric-card">
            <div class="metric-title">Memory Usage</div>
            <div class="metric-value" id="memValue">-- MB</div>
            <div class="metric-list" id="memList">No data yet</div>
          </div>

          <div class="metric-card" style="grid-column: 1 / -1;">
            <div class="metric-title">Operation Timings</div>
            <div class="metric-list" id="timingList">No operations yet</div>
          </div>
        </div>

        <div class="data-section">
          <h3>Performance Data (Copy for Analysis)</h3>
          <button id="captureBtn">Start Capture</button>
          <button id="exportBtn">Export JSON</button>
          <button id="exportHtmlBtn">Export HTML Report</button>
          <button id="copyDataBtn">Copy Data to Clipboard</button>
          <button id="exportDataBtn">Export to File</button>
          <pre id="dataDisplay">No data yet...</pre>
        </div>

        <div id="htmlReport" style="display: none;"></div>

        <div id="status" class="status">
          Waiting for performance data... Click buttons in Edge Panel to start monitoring.
        </div>

        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
        </script>
        <script nonce="${nonce}" src="${jsUri}"></script>
      </body>
      </html>
    `;
  }
}

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
