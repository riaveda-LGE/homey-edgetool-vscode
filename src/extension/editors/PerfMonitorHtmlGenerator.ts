// === src/extension/editors/PerfMonitorHtmlGenerator.ts ===
import * as path from 'path';
import * as vscode from 'vscode';

import type { IPerfMonitorHtmlGenerator } from './IPerfMonitorPanelComponents.js';

export class PerfMonitorHtmlGenerator implements IPerfMonitorHtmlGenerator {
  private _extensionUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri) {
    this._extensionUri = extensionUri;
  }

  generateHtmlReport(result: any, isForWebview: boolean = false): string {
    const a = result.analysis || {};

    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Performance Report</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 20px;
      background-color: #1e1e1e;
      color: #cccccc;
    }
    h1, h2 {
      color: #ffffff;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      background-color: #2d2d2d;
      color: #cccccc;
    }
    th, td {
      border: 1px solid #555;
      padding: 8px;
      text-align: left;
    }
    th {
      background-color: #3c3c3c;
      color: #ffffff;
    }
    .bottleneck {
      background-color: #4d2d2d;
    }
    .insight {
      background-color: #2d3c4d;
      color: #ffffff;
      padding: 10px;
      margin: 10px 0;
      border-left: 4px solid #007acc;
    }
    tr:nth-child(even) {
      background-color: #252525;
    }
    tr:hover {
      background-color: #3a3a3a;
    }
  </style>
</head>
<body>
  <h1>Performance Report</h1>
  <h2>Summary</h2>
  <p>Duration: ${(result.duration / 1000).toFixed(2)}s</p>
  <p>Total Samples: ${a.totalSamples || 0}</p>
  <p>Avg CPU User: ${((a.avgCpuUser || 0) / 1000).toFixed(2)}ms</p>
  <p>Avg Memory: ${((a.avgMemory || 0) / 1024 / 1024).toFixed(2)}MB</p>

  <h2>Insights</h2>
  ${(a.insights || []).map((insight: string) => `<div class="insight">${insight}</div>`).join('')}

  <h2>Function Calls</h2>
  <table>
    <tr><th>Function</th><th>Calls</th><th>Avg Time (ms)</th><th>Max Time (ms)</th><th>Total Time (ms)</th></tr>
    ${Object.entries(a.functionSummary || {})
      .map(
        ([name, stats]: [string, any]) =>
          `<tr class="${(a.bottlenecks?.slowFunctions || []).includes(name) ? 'bottleneck' : ''}">
        <td>${name}</td><td>${stats?.count || 0}</td><td>${(stats?.avgTime || 0).toFixed(2)}</td><td>${(stats?.maxTime || 0).toFixed(2)}</td><td>${(stats?.totalTime || 0).toFixed(2)}</td>
      </tr>`,
      )
      .join('')}
  </table>

  ${
    a.ioAnalysis && a.ioAnalysis.totalOperations > 0
      ? `
  <h2>I/O Operations</h2>
  <table>
    <tr><th>Operation</th><th>Count</th><th>Avg Time (ms)</th><th>Max Time (ms)</th><th>Total Time (ms)</th><th>Total Bytes</th><th>Errors</th></tr>
    ${
      Object.entries(a.ioAnalysis?.perOp || {})
        .map(([op, s]: [string, any]) =>
          `<tr><td>${op}</td><td>${s.count}</td><td>${(s.avgDuration||0).toFixed(2)}</td><td>${(s.maxDuration||0).toFixed(2)}</td><td>${(s.totalTime||0).toFixed(2)}</td><td>${s.totalBytes ?? 0}</td><td>${s.errors ?? 0}</td></tr>`
        )
        .join('')
    }
  </table>
  `
      : ''
  }

</body>
</html>`;
    return html;
  }

  getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this._extensionUri,
        'dist',
        'webviewers',
        'perf-monitor',
        'app.bundle.js',
      ),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webviewers', 'perf-monitor', 'style.css'),
    );
    const chartUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webviewers', 'perf-monitor', 'chart.umd.js'),
    );

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
    <div id="buttons">
        <button id="captureBtn">Start Capture</button>
        <button id="exportBtn">Export JSON</button>
        <button id="exportHtmlBtn">Export HTML Report</button>
    </div>
  <div id="chart"></div>
    <div id="htmlReport"></div>
    <script src="${chartUri}"></script>
    <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
