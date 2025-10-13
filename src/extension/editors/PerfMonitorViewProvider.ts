// === src/extension/editors/PerfMonitorPanel.ts ===
import * as vscode from 'vscode';
import { getLogger } from '../../core/logging/extension-logger.js';

interface PerfData {
  timestamp: string;
  cpu: NodeJS.CpuUsage;
  memory: NodeJS.MemoryUsage;
  responseTime?: number;
}

export class PerfMonitorPanel {
  public static readonly viewType = 'perfMonitor';
  private _panel?: vscode.WebviewPanel;
  private _interval?: NodeJS.Timeout;
  private _data: PerfData[] = [];
  private _isMonitoring = false;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public createPanel() {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.One);
      return;
    }

    this._panel = vscode.window.createWebviewPanel(
      PerfMonitorPanel.viewType,
      'Performance Monitor',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [this._extensionUri],
      }
    );

    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

    this._panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.type) {
          case 'exportJson':
            this._exportJson();
            break;
        }
      },
      undefined,
      []
    );

    this._panel.onDidDispose(() => {
      this.stopMonitoring();
      this._panel = undefined;
    });
  }

  public closePanel() {
    if (this._panel) {
      this._panel.dispose();
      this._panel = undefined;
    }
  }

  public startMonitoring() {
    if (this._isMonitoring) return;
    this._isMonitoring = true;
    this._data = [];
    this._interval = setInterval(() => {
      const data: PerfData = {
        timestamp: new Date().toISOString(),
        cpu: process.cpuUsage(),
        memory: process.memoryUsage(),
      };
      this._data.push(data);
      this._updateView();
    }, 1000);
  }

  public stopMonitoring() {
    if (!this._isMonitoring) return;
    this._isMonitoring = false;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = undefined;
    }
  }

  private _updateView() {
    if (this._panel) {
      this._panel.webview.postMessage({
        type: 'updateData',
        data: this._data.slice(-100), // 최근 100개
      });
    }
  }

  private _exportJson() {
    const json = {
      version: '1.0',
      environment: {
        nodeVersion: process.version,
        vscodeVersion: vscode.version,
        platform: process.platform,
        extensionVersion: '0.0.2',
      },
      data: this._data,
      summary: {
        totalSamples: this._data.length,
        avgCpuUser: this._data.reduce((sum, d) => sum + d.cpu.user, 0) / this._data.length || 0,
        avgCpuSystem: this._data.reduce((sum, d) => sum + d.cpu.system, 0) / this._data.length || 0,
        maxMemory: Math.max(...this._data.map(d => d.memory.heapUsed)),
        minMemory: Math.min(...this._data.map(d => d.memory.heapUsed)),
      },
    };
    const uri = vscode.Uri.parse(`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(json, null, 2))}`);
    vscode.env.openExternal(uri);
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'src', 'ui', 'perf-monitor', 'app.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'src', 'ui', 'perf-monitor', 'style.css'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Performance Monitor</title>
    <link href="${styleUri}" rel="stylesheet">
</head>
<body>
    <h2>Performance Monitor</h2>
    <div id="chart"></div>
    <button id="exportBtn">Export JSON</button>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
