import * as vscode from 'vscode';

import { PERF_DATA_MAX } from '../../shared/const.js';
import { PerfMonitorCommandHandler } from './PerfMonitorCommandHandler.js';
import { PerfMonitorDataManager } from './PerfMonitorDataManager.js';
import { PerfMonitorWebviewManager } from './PerfMonitorWebviewManager.js';

export interface PerfMonitor {
  createPanel(): void;
  closePanel(): void;
  dispose(): void;
}

export class PerfMonitorEditorProvider implements PerfMonitor {
  private static _instance: PerfMonitorEditorProvider | null = null;
  private _dataManager: PerfMonitorDataManager;
  private _webviewManager: PerfMonitorWebviewManager;
  private _commandHandler: PerfMonitorCommandHandler;
  private _disposables = new Set<() => void>();
  private _perfLogPath: vscode.Uri | null = null;

  private constructor(private _extensionUri: vscode.Uri) {
    this._dataManager = new PerfMonitorDataManager();
    this._webviewManager = new PerfMonitorWebviewManager(this._dataManager, this._extensionUri);
    this._commandHandler = new PerfMonitorCommandHandler(this._dataManager, this._webviewManager);
  }

  static getInstance(extensionUri?: vscode.Uri): PerfMonitorEditorProvider {
    if (!PerfMonitorEditorProvider._instance) {
      if (!extensionUri) {
        throw new Error('Extension URI is required for first instance creation');
      }
      PerfMonitorEditorProvider._instance = new PerfMonitorEditorProvider(extensionUri);
    }
    return PerfMonitorEditorProvider._instance;
  }

  private _trackDisposable(disposable: vscode.Disposable) {
    this._disposables.add(() => disposable.dispose());
  }

  static register(context: vscode.ExtensionContext, extensionUri: vscode.Uri): vscode.Disposable {
    const provider = PerfMonitorEditorProvider.getInstance(extensionUri);

    // 명령어 등록
    const disposables = provider._commandHandler.registerCommands(context);

    return {
      dispose: () => {
        disposables.forEach(d => d.dispose());
        provider.dispose();
      }
    };
  }

  createPanel() {
    this._webviewManager.createPanel();
  }

  closePanel() {
    this._webviewManager.closePanel();
  }

  // 성능 데이터 전송 및 로깅
  async updatePerf(data: any) {
    // 데이터 저장
    this._dataManager.addPerfData(data);

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
    this._webviewManager.updatePanel();
  }

  // 성능 데이터 파일 저장

  setPerfMode(enabled: boolean) {
    this._dataManager.setPerfMode(enabled);
    if (enabled) {
      this.startPerfLogging();
      this.createPanel();
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
            totalRecords: this._dataManager.getPerfData().length
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

  dispose() {
    this._webviewManager.dispose();
    // 모든 추적된 리소스 정리
    for (const dispose of this._disposables) {
      dispose();
    }
    this._disposables.clear();
  }
}
