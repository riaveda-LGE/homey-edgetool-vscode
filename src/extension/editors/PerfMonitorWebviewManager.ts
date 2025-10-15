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
        localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'ui', 'perf-monitor')],
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
        this._webviewPanel!.webview.postMessage({ type: 'perf.update', data: item });
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
        this._webviewPanel?.webview.postMessage({ type: 'perf.update', data: item });
      });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    // HTML 내용은 PerfMonitorEditorProvider.ts에서 복사
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
          <button id="copyDataBtn">Copy Data to Clipboard</button>
          <button id="exportDataBtn">Export to File</button>
          <pre id="dataDisplay">No data yet...</pre>
        </div>

        <div id="status" class="status">
          Waiting for performance data... Click buttons in Edge Panel to start monitoring.
        </div>

        <script>
          const vscode = acquireVsCodeApi();

          let perfData = { cpu: [], memory: [], timings: [] };

          // 데이터 표시 업데이트
          function updateDataDisplay() {
            const dataStr = JSON.stringify(perfData, null, 2);
            document.getElementById('dataDisplay').textContent = dataStr;
          }

          // 복사 버튼
          document.getElementById('copyDataBtn').addEventListener('click', async () => {
            const dataStr = JSON.stringify(perfData, null, 2);
            try {
              await navigator.clipboard.writeText(dataStr);
              alert('Performance data copied to clipboard!');
            } catch (err) {
              // Fallback for older browsers
              const textArea = document.createElement('textarea');
              textArea.value = dataStr;
              document.body.appendChild(textArea);
              textArea.select();
              textArea.focus();
              document.execCommand('selectall');
              document.execCommand('copy');
              document.body.removeChild(textArea);
              alert('Performance data copied to clipboard!');
            }
          });

          // 내보내기 버튼
          document.getElementById('exportDataBtn').addEventListener('click', () => {
            const dataStr = JSON.stringify(perfData, null, 2);
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'homey-perf-data-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          });

          // 데이터 업데이트 함수
          function updateDisplay(data) {
            // CPU 데이터
            if (data.cpuDelta) {
              perfData.cpu.push({
                user: data.cpuDelta.user,
                system: data.cpuDelta.system,
                timestamp: data.timestamp
              });
              if (perfData.cpu.length > 10) perfData.cpu.shift();

              const latest = perfData.cpu[perfData.cpu.length - 1];
              document.getElementById('cpuValue').textContent =
                \`\${(latest.user + latest.system).toFixed(2)} ms\`;

              document.getElementById('cpuList').innerHTML = perfData.cpu
                .map(entry =>
                  \`<div class="perf-entry">
                    \${new Date(entry.timestamp).toLocaleTimeString()}:
                    User \${entry.user.toFixed(2)}ms, System \${entry.system.toFixed(2)}ms
                  </div>\`
                ).join('');
            }

            // 메모리 데이터
            if (data.memDelta) {
              perfData.memory.push({
                heapUsed: data.memDelta.heapUsed,
                rss: data.memDelta.rss,
                timestamp: data.timestamp
              });
              if (perfData.memory.length > 10) perfData.memory.shift();

              const latest = perfData.memory[perfData.memory.length - 1];
              document.getElementById('memValue').textContent =
                \`\${latest.heapUsed.toFixed(2)} MB\`;

              document.getElementById('memList').innerHTML = perfData.memory
                .map(entry =>
                  \`<div class="perf-entry">
                    \${new Date(entry.timestamp).toLocaleTimeString()}:
                    Heap \${entry.heapUsed.toFixed(2)}MB, RSS \${entry.rss.toFixed(2)}MB
                  </div>\`
                ).join('');
            }

            // 타이밍 데이터
            perfData.timings.push({
              operation: data.operation,
              duration: data.duration,
              timestamp: data.timestamp
            });
            if (perfData.timings.length > 20) perfData.timings.shift();

            document.getElementById('timingList').innerHTML = perfData.timings
              .map(entry =>
                \`<div class="perf-entry">
                  \${new Date(entry.timestamp).toLocaleTimeString()} -
                  \${entry.operation}: \${data.duration?.toFixed(2)}ms
                </div>\`
              ).join('');

            // 상태 업데이트
            document.getElementById('status').textContent =
              \`Last update: \${new Date(data.timestamp).toLocaleTimeString()} - \${data.operation}\`;

            // 데이터 표시 업데이트
            updateDataDisplay();
          }

          // VS Code 메시지 수신
          window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type === 'perf.update') {
              updateDisplay(msg.data);
            }
          });

          // 준비 완료 알림
          vscode.postMessage({ type: 'perf.ready' });
        </script>
      </body>
      </html>
    `;
  }
}
