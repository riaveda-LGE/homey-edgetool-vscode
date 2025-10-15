// === src/extension/editors/PerfMonitorExportManager.ts ===
import * as vscode from 'vscode';
import { getLogger } from '../../core/logging/extension-logger.js';
import { globalProfiler } from '../../core/logging/perf.js';
import { resolveWorkspaceInfo } from '../../core/config/userdata.js';
import type { IPerfMonitorExportManager } from './IPerfMonitorPanelComponents.js';

export class PerfMonitorExportManager implements IPerfMonitorExportManager {
  private _webviewPerfData: Array<{name: string, duration: number}> = [];
  private _data: any[] = [];
  private _context: vscode.ExtensionContext;
  private _onFileCreated?: (path: string) => void;

  constructor(context: vscode.ExtensionContext, onFileCreated?: (path: string) => void) {
    this._context = context;
    this._onFileCreated = onFileCreated;
  }

  setWebviewPerfData(data: Array<{name: string, duration: number}>): void {
    this._webviewPerfData = data;
  }

  setMonitoringData(data: any[]): void {
    this._data = data;
  }

  async exportJson(): Promise<void> {
    const log = getLogger('perfMonitor');
    try {
      log.info('Starting exportJson');
      const captureResult = globalProfiler.getLastCaptureResult();
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

      log.info('Getting workspace info using resolveWorkspaceInfo');
      const workspaceInfo = await resolveWorkspaceInfo(this._context);
      const workspaceFolder = { uri: workspaceInfo.wsDirUri };
      log.info(`User workspace folder: ${workspaceFolder.uri.fsPath}`);

      const perfFolderUri = vscode.Uri.joinPath(workspaceFolder.uri, 'perf');
      log.info(`Perf folder URI: ${perfFolderUri.fsPath}`);

      try {
        await vscode.workspace.fs.stat(perfFolderUri);
        log.info('Perf folder already exists');
      } catch {
        log.info('Creating perf folder');
        await vscode.workspace.fs.createDirectory(perfFolderUri);
        log.info('Perf folder created');
      }

      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `${timestamp}.json`;
      const fileUri = vscode.Uri.joinPath(perfFolderUri, filename);
      log.info(`File URI: ${fileUri.fsPath}`);

      const jsonString = JSON.stringify(json, null, 2);
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(jsonString, 'utf8'));
      log.info('File written successfully');

      // 파일 생성 후 콜백 호출 (explorer 갱신용)
      this._onFileCreated?.(fileUri.fsPath);
    } catch (error) {
      log.error(`Export error: ${error}`);
      vscode.window.showErrorMessage(`Failed to export performance data: ${error}`);
    }
  }

  async exportDisplayedHtml(html: string): Promise<void> {
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
      
      // 파일 생성 후 콜백 호출 (explorer 갱신용)
      this._onFileCreated?.(fileUri.fsPath);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to export HTML report: ${error}`);
    }
  }
}
