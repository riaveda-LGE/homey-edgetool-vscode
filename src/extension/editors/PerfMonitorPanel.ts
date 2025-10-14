// === src/extension/editors/PerfMonitorPanel.ts ===
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../core/logging/extension-logger.js';
import { globalProfiler, PerformanceProfiler, measure } from '../../core/logging/perf.js';
import { resolveWorkspaceInfo } from '../../core/config/userdata.js';
import type { H2W, W2H } from '../messaging/messageTypes.js';

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
  private _captureInterval?: NodeJS.Timeout;
  private _captureData: PerfData[] = [];
  private _isCapturing = false;
  private _webviewPerfData: Array<{name: string, duration: number}> = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {}

  // 정적 메서드로 명령어 등록
  public static register(context: vscode.ExtensionContext, extensionUri: vscode.Uri) {
    const perfProvider = new PerfMonitorPanel(extensionUri, context);

    // ✅ Performance Toggle 명령어 등록 (package.json에 선언된 명령어 구현)
    const toggleCommand = vscode.commands.registerCommand('performance.toggle', async () => {
      await globalProfiler.measureFunction('performance.toggle', async () => {
        perfProvider.createPanel();
      });
    });
    context.subscriptions.push(toggleCommand);

    return perfProvider;
  }

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
      (message: W2H) => {
        console.log('PerfMonitorPanel received message:', message);
        switch (message.type) {
          case 'perf.exportJson':
            this._exportJson();
            break;
          case 'perf.startCapture':
            console.log('Starting capture...');
            this._startCapture();
            break;
          case 'perf.stopCapture':
            console.log('Stopping capture...');
            this._stopCapture();
            break;
          case 'perfMeasure':
            this._webviewPerfData.push({ name: message.payload.name, duration: message.payload.duration });
            break;
          case 'perf.exportHtmlReport':
            this._exportDisplayedHtml(message.payload.html);
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
    if (this._captureInterval) {
      clearInterval(this._captureInterval);
      this._captureInterval = undefined;
    }
    if (this._panel) {
      this._panel.dispose();
      this._panel = undefined;
    }
  }

  @measure()
  private _startCapture() {
    console.log('PerfMonitorPanel._startCapture called');
    this._profiler.enable();  // ✅ Start Capture 시 자동으로 모니터링 모드 켜기
    this._profiler.startCapture();
    this._isCapturing = true;
    this._webviewPerfData = []; // 초기화
    this._captureData = []; // 캡처 데이터 초기화
    console.log('Capture started, sending captureStarted message to webview');
    if (this._panel) {
      this._panel.webview.postMessage({
        v: 1,
        type: 'perf.captureStarted',
        payload: {}
      } as H2W);
      console.log('captureStarted message sent');
    } else {
      console.log('No panel available to send message');
    }

    // 실시간 데이터 전송 시작
    this._captureInterval = setInterval(() => {
      if (this._isCapturing && this._panel) {
        const data: PerfData = {
          timestamp: new Date().toISOString(),
          cpu: process.cpuUsage(),
          memory: process.memoryUsage(),
        };
        this._captureData.push(data);
        // 최근 100개만 유지
        if (this._captureData.length > 100) {
          this._captureData.shift();
        }
    // Webview에 실시간 데이터 전송
    this._panel.webview.postMessage({
      v: 1,
      type: 'perf.updateData',
      payload: { data: this._captureData }
    } as H2W);
      }
    }, 1000);
  }

  @measure()
  private _recordFunctionCall(name: string, duration: number) {
    this._profiler.measureFunction(name, async () => {}); // Record the call
  }

  @measure()
  private _stopCapture() {
    const result = this._profiler.stopCapture();
    this._isCapturing = false;
    this._profiler.disable();  // ✅ Stop Capture 시 모니터링 모드 끄기

    // 실시간 데이터 전송 중지
    if (this._captureInterval) {
      clearInterval(this._captureInterval);
      this._captureInterval = undefined;
    }

    // Webview 데이터 통합
  const combinedFunctionCalls = [...(result.functionCalls || []), ...this._webviewPerfData.map((d: any) => ({ name: d.name, start: 0, duration: d.duration }))];
  const combinedResult = { ...result, functionCalls: combinedFunctionCalls };
    // HTML 보고서 생성 (웹뷰용과 익스포트용)
    const webviewHtml = this._generateHtmlReport(combinedResult, true);
    const exportHtml = this._generateHtmlReport(combinedResult, false);
    if (this._panel) {
      this._panel.webview.postMessage({
        v: 1,
        type: 'perf.captureStopped',
        payload: { result: combinedResult, htmlReport: webviewHtml, exportHtml }
      } as H2W);
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

  private _generateHtmlReport(result: any, isForWebview: boolean = false): string {
    const a = result.analysis || {};
    
    let html = `
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

  
  private _getMaxDepth(node: any, depth = 0): number {
    if (!node || !node.children || node.children.length === 0) return depth;
    return Math.max(...node.children.map((child: any) => this._getMaxDepth(child, depth + 1)));
  }

  private _getNodesAtDepth(node: any, targetDepth: number, currentDepth = 0): any[] {
    if (currentDepth === targetDepth) return [node];

    if (!node || !node.children) return [];

    return node.children.flatMap((child: any) => this._getNodesAtDepth(child, targetDepth, currentDepth + 1));
  }

  private _getColorForDepth(depth: number): string {
    const colors = ['#007acc', '#0099ff', '#00ccff', '#00ffcc', '#00ff99', '#00ff66', '#66ff00', '#ccff00', '#ffff00', '#ffcc00'];
    return colors[depth % colors.length];
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'ui', 'perf-monitor', 'app.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'ui', 'perf-monitor', 'style.css'));
    const chartUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'ui', 'perf-monitor', 'chart.umd.js'));
  // no d3 dependency
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
