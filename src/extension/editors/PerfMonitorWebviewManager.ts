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
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webviewers', 'perf-monitor', 'bundle.js'));
    const cspSource = webview.cspSource;

    // HTML 내용은 PerfMonitorEditorProvider.ts에서 복사
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}';">
        <title>Homey EdgeTool Performance Monitor</title>
        <style>
          body {
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 20px;
            margin: 0;
          }
          .header {
            text-align: center;
            margin-bottom: 30px;
          }
          .chart-container {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 15px;
            margin-bottom: 20px;
          }
          .metrics {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin-bottom: 20px;
          }
          .metric-card {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 15px;
          }
          .metric-title {
            font-weight: bold;
            margin-bottom: 10px;
            color: var(--vscode-textLink-foreground);
          }
          .metric-value {
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 5px;
          }
          .metric-list {
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            background: var(--vscode-input-background);
            padding: 10px;
            border-radius: 4px;
            max-height: 200px;
            overflow-y: auto;
          }
          .status {
            text-align: center;
            padding: 10px;
            background: var(--vscode-notificationsInfoIcon-foreground);
            color: var(--vscode-notifications-background);
            border-radius: 4px;
            margin-top: 20px;
          }
          .perf-entry {
            margin: 5px 0;
            padding: 5px;
            border-left: 3px solid var(--vscode-textLink-foreground);
            background: var(--vscode-list-inactiveSelectionBackground);
          }
          .data-section {
            margin-top: 30px;
            padding: 20px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
          }
          .data-section h3 {
            margin-top: 0;
            color: var(--vscode-textLink-foreground);
          }
          .data-section button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            margin-right: 10px;
            margin-bottom: 10px;
          }
          .data-section button:hover {
            background: var(--vscode-button-hoverBackground);
          }
          .data-section pre {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
            max-height: 300px;
            overflow-y: auto;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            white-space: pre-wrap;
            word-break: break-all;
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
