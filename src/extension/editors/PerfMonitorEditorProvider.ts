import * as vscode from 'vscode';

export class PerfMonitorEditorProvider {
  private static _instance: PerfMonitorEditorProvider | null = null;
  private _perfMode = false;
  private _webviewPanel: vscode.WebviewPanel | null = null;
  private _perfData: any[] = [];

  static getInstance(): PerfMonitorEditorProvider {
    if (!PerfMonitorEditorProvider._instance) {
      PerfMonitorEditorProvider._instance = new PerfMonitorEditorProvider();
    }
    return PerfMonitorEditorProvider._instance;
  }

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = PerfMonitorEditorProvider.getInstance();

    // 명령어 등록 - on/off 선택
    const openCommand = vscode.commands.registerCommand('homey.openPerfMonitor', async () => {
      const items = [
        { label: 'ON - 성능 모니터링 시작', description: '실시간 성능 데이터를 모니터링합니다', value: 'on' },
        { label: 'OFF - 성능 모니터링 종료', description: '모니터링을 중지하고 창을 닫습니다', value: 'off' }
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: '성능 모니터링 모드를 선택하세요',
        matchOnDescription: true
      });

      if (!selected) return;

      if (selected.value === 'on') {
        // ON 선택: 모니터링 시작
        provider.setPerfMode(true);
        provider.openMonitorWindow();
      } else {
        // OFF 선택: 모니터링 중지 및 창 닫기
        provider.setPerfMode(false);
        provider.closeMonitorWindow();
      }
    });
    context.subscriptions.push(openCommand);

    return openCommand;
  }

  private openMonitorWindow() {
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
        localResourceRoots: []
      }
    );

    // HTML 설정
    this._webviewPanel.webview.html = this.getHtml(this._webviewPanel.webview);

    // 메시지 핸들링
    this._webviewPanel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'perf.ready') {
        this.sendInitialData();
      }
    });

    // 패널 닫힐 때 정리
    this._webviewPanel.onDidDispose(() => {
      this._webviewPanel = null;
    });
  }

  private closeMonitorWindow() {
    if (this._webviewPanel) {
      this._webviewPanel.dispose();
      this._webviewPanel = null;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    // Chart.js 대신 간단한 텍스트 기반 UI 사용
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

  // 성능 데이터 전송 및 로깅
  async updatePerf(data: any) {
    // 데이터 저장
    this._perfData.push(data);
    if (this._perfData.length > 1000) {
      this._perfData.shift(); // 메모리 제한
    }

    // 파일에 기록
    if (this._perfLogPath) {
      try {
        const logEntry = {
          timestamp: data.timestamp,
          operation: data.operation,
          duration: data.duration,
          cpuDelta: data.cpuDelta,
          memDelta: data.memDelta
        };
        const content = Buffer.from(JSON.stringify(logEntry) + '\n');
        const existingContent = await vscode.workspace.fs.readFile(this._perfLogPath);
        const newContent = Buffer.concat([existingContent, content]);
        await vscode.workspace.fs.writeFile(this._perfLogPath, newContent);
      } catch (error) {
        // 로깅 실패는 무시 (성능 모니터링에 영향 주지 않음)
      }
    }

    // Webview에 전송
    if (this._webviewPanel && this._perfMode) {
      this._webviewPanel.webview.postMessage({ type: 'perf.update', data });
    }
  }

  // 성능 데이터 파일 저장
  private _perfLogPath: vscode.Uri | null = null;

  setPerfMode(enabled: boolean) {
    this._perfMode = enabled;
    if (enabled) {
      this.startPerfLogging();
      this.openMonitorWindow();
    } else {
      this.stopPerfLogging();
    }
  }

  private async startPerfLogging() {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;

      const perfDir = vscode.Uri.joinPath(workspaceFolder.uri, '.homey-perf');
      await vscode.workspace.fs.createDirectory(perfDir);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      this._perfLogPath = vscode.Uri.joinPath(perfDir, `perf-${timestamp}.jsonl`);

      // 초기 데이터 구조 작성
      const initialData = {
        session: {
          startTime: Date.now(),
          vscodeVersion: vscode.version,
          platform: process.platform,
          arch: process.arch
        }
      };
      await vscode.workspace.fs.writeFile(this._perfLogPath, Buffer.from(JSON.stringify(initialData) + '\n'));
    } catch (error) {
      vscode.window.showErrorMessage('Failed to start performance logging: ' + error);
    }
  }

  private async stopPerfLogging() {
    if (this._perfLogPath) {
      try {
        const finalData = {
          session: {
            endTime: Date.now(),
            totalRecords: this._perfData.length
          }
        };
        const content = Buffer.from(JSON.stringify(finalData) + '\n');
        // 기존 파일에 append
        const existingContent = await vscode.workspace.fs.readFile(this._perfLogPath);
        const newContent = Buffer.concat([existingContent, content]);
        await vscode.workspace.fs.writeFile(this._perfLogPath, newContent);

        vscode.window.showInformationMessage(
          `Performance log saved: ${vscode.workspace.asRelativePath(this._perfLogPath)}`
        );
      } catch (error) {
        vscode.window.showErrorMessage('Failed to save performance log: ' + error);
      }
      this._perfLogPath = null;
    }
  }

  private sendInitialData() {
    // 초기 데이터 전송 (필요시)
    if (this._perfData.length > 0) {
      this._perfData.forEach(data => {
        this.updatePerf(data);
      });
    }
  }
}
