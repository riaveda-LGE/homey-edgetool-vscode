// === src/extension/editors/PerfMonitorPanel.ts ===
import * as vscode from 'vscode';
import { getLogger } from '../../core/logging/extension-logger.js';
import { globalProfiler, PerformanceProfiler, measure } from '../../core/logging/perf.js';
import { resolveWorkspaceInfo } from '../../core/config/userdata.js';

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
  private _profiler = globalProfiler;
  private _isCapturing = false;
  private _webviewPerfData: Array<{name: string, duration: number}> = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {}

  @measure()
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
        console.log('PerfMonitorPanel received message:', message);
        switch (message.type) {
          case 'exportJson':
            this._exportJson();
            break;
          case 'startCapture':
            console.log('Starting capture...');
            this._startCapture();
            break;
          case 'stopCapture':
            console.log('Stopping capture...');
            this._stopCapture();
            break;
          case 'functionCall':
            this._recordFunctionCall(message.name, message.duration);
            break;
          case 'perfMeasure':
            this._webviewPerfData.push({ name: message.name, duration: message.duration });
            break;
          case 'exportHtmlReport':
            this._exportDisplayedHtml(message.html);
            break;
        }
      },
      undefined,
      []
    );

    this._panel.onDidDispose(() => {
      this.dispose();
    });
  }

  @measure()
  public closePanel() {
    if (this._panel) {
      this._panel.dispose();
      this._panel = undefined;
    }
  }

  @measure()
  public dispose() {
    this.stopMonitoring();
    if (this._panel) {
      this._panel.dispose();
      this._panel = undefined;
    }
  }

  @measure()
  public startMonitoring() {
    this._profiler.enable();
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
    }, 1000);
  }

  @measure()
  public stopMonitoring() {
    this._profiler.disable();
    if (!this._isMonitoring) return;
    this._isMonitoring = false;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = undefined;
    }
  }

  @measure()
  private _startCapture() {
    console.log('PerfMonitorPanel._startCapture called');
    this._profiler.startCapture();
    this._isCapturing = true;
    this._webviewPerfData = []; // 초기화
    console.log('Capture started, sending captureStarted message to webview');
    if (this._panel) {
      this._panel.webview.postMessage({ type: 'captureStarted' });
      console.log('captureStarted message sent');
    } else {
      console.log('No panel available to send message');
    }
  }

  @measure()
  private _recordFunctionCall(name: string, duration: number) {
    this._profiler.measureFunction(name, async () => {}); // Record the call
  }

  @measure()
  private _stopCapture() {
    const result = this._profiler.stopCapture();
    this._isCapturing = false;
    // Webview 데이터 통합
    const combinedFunctionCalls = [...(result.functionCalls || []), ...this._webviewPerfData.map((d: any) => ({ name: d.name, start: 0, duration: d.duration }))];
    const combinedResult = { ...result, functionCalls: combinedFunctionCalls };
    // HTML 보고서 생성
    const htmlReport = this._generateHtmlReport(combinedResult);
    if (this._panel) {
      this._panel.webview.postMessage({ type: 'captureStopped', result: combinedResult, htmlReport });
    }
  }

  @measure()
  private async _exportDisplayedHtml(html: string) {
    try {
      const workspaceInfo = await resolveWorkspaceInfo(this._context);
      const workspaceFolder = { uri: workspaceInfo.wsDirUri };
      const perfFolderUri = vscode.Uri.joinPath(workspaceFolder.uri, 'perf');
      
      try {
        await vscode.workspace.fs.stat(perfFolderUri);
      } catch {
        await vscode.workspace.fs.createDirectory(perfFolderUri);
      }
      
      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `${timestamp}-report.html`;
      const fileUri = vscode.Uri.joinPath(perfFolderUri, filename);
      
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(html, 'utf8'));
      vscode.window.showInformationMessage(`HTML report exported to: perf/${filename}`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to export HTML report: ${error}`);
    }
  }

  private _generateHtmlReport(result: any): string {
    const a = result.analysis;
    let html = `
<!DOCTYPE html>
<html>
<head>
  <title>Performance Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    h1, h2 { color: #333; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #f2f2f2; }
    .bottleneck { background-color: #ffe6e6; }
    .insight { background-color: #e6f7ff; padding: 10px; margin: 10px 0; }
  </style>
</head>
<body>
  <h1>Performance Report</h1>
  <h2>Summary</h2>
  <p>Duration: ${(result.duration / 1000).toFixed(2)}s</p>
  <p>Total Samples: ${a.totalSamples}</p>
  <p>Avg CPU User: ${(a.avgCpuUser / 1000).toFixed(2)}ms</p>
  <p>Avg Memory: ${(a.avgMemory / 1024 / 1024).toFixed(2)}MB</p>
  
  <h2>Insights</h2>
  ${a.insights.map((insight: string) => `<div class="insight">${insight}</div>`).join('')}
  
  <h2>Function Calls</h2>
  <table>
    <tr><th>Function</th><th>Calls</th><th>Avg Time (ms)</th><th>Max Time (ms)</th><th>Total Time (ms)</th></tr>
    ${Object.entries(a.functionSummary).map(([name, stats]: [string, any]) => 
      `<tr class="${a.bottlenecks.slowFunctions.includes(name) ? 'bottleneck' : ''}">
        <td>${name}</td><td>${stats.count}</td><td>${stats.avgTime.toFixed(2)}</td><td>${stats.maxTime.toFixed(2)}</td><td>${stats.totalTime.toFixed(2)}</td>
      </tr>`).join('')}
  </table>
  
  <h2>Flame Graph</h2>
  <div id="flameGraph">${JSON.stringify(a.flameGraph)}</div>
</body>
</html>`;
    return html;
  }

  @measure()
  private async _exportJson() {
    try {
      console.log('Starting _exportJson');
      const captureResult = this._profiler.getLastCaptureResult(); // Get last capture result without stopping
      const combinedFunctionCalls = [...(captureResult?.functionCalls || []), ...this._webviewPerfData.map((d: any) => ({ name: d.name, start: 0, duration: d.duration }))];
      const combinedResult = { ...captureResult, functionCalls: combinedFunctionCalls };
      const json = {
        version: '1.0',
        environment: {
          nodeVersion: process.version,
          vscodeVersion: vscode.version,
          platform: process.platform,
          extensionVersion: '0.0.2',
        },
        monitoringData: this._data || [],
        captureData: combinedResult.samples,
        captureAnalysis: combinedResult.analysis,
        summary: {
          totalMonitoringSamples: (this._data || []).length,
          captureDuration: combinedResult.duration,
          avgCpuUser: (this._data || []).reduce((sum: number, d: any) => sum + d.cpu.user, 0) / (this._data || []).length || 0,
          avgCpuSystem: (this._data || []).reduce((sum: number, d: any) => sum + d.cpu.system, 0) / (this._data || []).length || 0,
          maxMemory: Math.max(...(this._data || []).map((d: any) => d.memory.heapUsed)),
          minMemory: Math.min(...(this._data || []).map((d: any) => d.memory.heapUsed)),
        },
      };

      // Get user workspace folder using resolveWorkspaceInfo
      console.log('Getting workspace info using resolveWorkspaceInfo');
      const workspaceInfo = await resolveWorkspaceInfo(this._context);
      const workspaceFolder = { uri: workspaceInfo.wsDirUri };
      console.log('User workspace folder:', workspaceFolder);

      // Create perf folder path
      const perfFolderUri = vscode.Uri.joinPath(workspaceFolder.uri, 'perf');
      console.log('Perf folder URI:', perfFolderUri);

      // Ensure perf folder exists
      try {
        await vscode.workspace.fs.stat(perfFolderUri);
        console.log('Perf folder already exists');
      } catch {
        console.log('Creating perf folder');
        await vscode.workspace.fs.createDirectory(perfFolderUri);
        console.log('Perf folder created');
      }

      // Generate timestamp-based filename
      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `${timestamp}.json`;
      const fileUri = vscode.Uri.joinPath(perfFolderUri, filename);
      console.log('File URI:', fileUri);

      // Write JSON file
      const jsonString = JSON.stringify(json, null, 2);
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(jsonString, 'utf8'));
      console.log('File written successfully');

      // Show success message
      vscode.window.showInformationMessage(`Performance data exported to: perf/${filename}`);
    } catch (error) {
      console.error('Export error:', error);
      vscode.window.showErrorMessage(`Failed to export performance data: ${error}`);
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'ui', 'perf-monitor', 'app.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'ui', 'perf-monitor', 'style.css'));

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
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
