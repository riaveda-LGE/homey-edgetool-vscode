// === src/extension/editors/PerfMonitorCaptureManager.ts ===
import * as vscode from 'vscode';

import { getLogger } from '../../core/logging/extension-logger.js';
import { globalProfiler, PerformanceProfiler } from '../../core/logging/perf.js';
import { PERF_UPDATE_INTERVAL_MS } from '../../shared/const.js';
import type { H2W } from '../messaging/messageTypes.js';
import type { IPerfMonitorCaptureManager,PerfData } from './IPerfMonitorPanelComponents.js';

export class PerfMonitorCaptureManager implements IPerfMonitorCaptureManager {
  private _profiler = globalProfiler;
  private _captureInterval?: NodeJS.Timeout;
  private _captureData: PerfData[] = [];
  private _isCapturing = false;
  private _webviewPerfData: Array<{name: string, duration: number}> = [];
  private _panel?: vscode.WebviewPanel;

  constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
  }

  get isCapturing(): boolean {
    return this._isCapturing;
  }

  startCapture(): void {
    const log = getLogger('perfMonitor');
    log.info('PerfMonitorCaptureManager.startCapture called');
    this._profiler.enable();
    this._profiler.startCapture();
    this._isCapturing = true;
    this._webviewPerfData = [];
    this._captureData = [];
    log.info('Capture started, sending captureStarted message to webview');
    if (this._panel) {
      this._panel.webview.postMessage({
        v: 1,
        type: 'perf.captureStarted',
        payload: {}
      } as H2W);
      log.info('captureStarted message sent');
    } else {
      log.warn('No panel available to send message');
    }

    this._captureInterval = setInterval(() => {
      if (this._isCapturing && this._panel) {
        const data: PerfData = {
          timestamp: new Date().toISOString(),
          cpu: process.cpuUsage(),
          memory: process.memoryUsage(),
        };
        this._captureData.push(data);
        if (this._captureData.length > 100) {
          this._captureData.shift();
        }
        this._panel.webview.postMessage({
          v: 1,
          type: 'perf.updateData',
          payload: { data: this._captureData }
        } as H2W);
      }
    }, PERF_UPDATE_INTERVAL_MS);
  }

  stopCapture(): void {
    const result = this._profiler.stopCapture();
    this._isCapturing = false;
    this._profiler.disable();

    if (this._captureInterval) {
      clearInterval(this._captureInterval);
      this._captureInterval = undefined;
    }

    const combinedFunctionCalls = [...(result.functionCalls || []), ...this._webviewPerfData.map((d: any) => ({ name: d.name, start: 0, duration: d.duration }))];
    const combinedResult = { ...result, functionCalls: combinedFunctionCalls };

    if (this._panel) {
      const webviewHtml = this.generateHtmlReport(combinedResult, true);
      const exportHtml = this.generateHtmlReport(combinedResult, false);
      this._panel.webview.postMessage({
        v: 1,
        type: 'perf.captureStopped',
        payload: { result: combinedResult, htmlReport: webviewHtml, exportHtml }
      } as H2W);
    }
  }

  private generateHtmlReport(result: any, isForWebview: boolean = false): string {
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
    ${Object.entries(a.functionSummary || {}).map(([name, stats]: [string, any]) =>
      `<tr class="${(a.bottlenecks?.slowFunctions || []).includes(name) ? 'bottleneck' : ''}">
        <td>${name}</td><td>${stats?.count || 0}</td><td>${(stats?.avgTime || 0).toFixed(2)}</td><td>${(stats?.maxTime || 0).toFixed(2)}</td><td>${(stats?.totalTime || 0).toFixed(2)}</td>
      </tr>`).join('')}
  </table>

  ${a.ioAnalysis && a.ioAnalysis.totalOperations > 0 ? `
  <h2>I/O Operations</h2>
  <table>
    <tr><th>Operation</th><th>Count</th><th>Avg Time (ms)</th><th>Max Time (ms)</th><th>Total Time (ms)</th><th>Errors</th></tr>
    ${a.ioAnalysis.readFile && a.ioAnalysis.readFile.count > 0 ?
      `<tr><td>File Read</td><td>${a.ioAnalysis.readFile.count}</td><td>${a.ioAnalysis.readFile.avgDuration.toFixed(2)}</td><td>${a.ioAnalysis.readFile.maxDuration.toFixed(2)}</td><td>${a.ioAnalysis.readFile.totalTime.toFixed(2)}</td><td>${a.ioAnalysis.readFile.errors}</td></tr>` : ''}
    ${a.ioAnalysis.writeFile && a.ioAnalysis.writeFile.count > 0 ?
      `<tr><td>File Write</td><td>${a.ioAnalysis.writeFile.count}</td><td>${a.ioAnalysis.writeFile.avgDuration.toFixed(2)}</td><td>${a.ioAnalysis.writeFile.maxDuration.toFixed(2)}</td><td>${a.ioAnalysis.writeFile.totalTime.toFixed(2)}</td><td>${a.ioAnalysis.writeFile.errors}</td></tr>` : ''}
  </table>
  ` : ''}

</body>
</html>`;
    return html;
  }

  addWebviewPerfData(name: string, duration: number): void {
    this._webviewPerfData.push({ name, duration });
  }

  dispose(): void {
    if (this._captureInterval) {
      clearInterval(this._captureInterval);
      this._captureInterval = undefined;
    }
  }
}
