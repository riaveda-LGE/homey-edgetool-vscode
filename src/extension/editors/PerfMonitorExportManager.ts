// === src/extension/editors/PerfMonitorExportManager.ts ===
import * as vscode from 'vscode';

import { resolveWorkspaceInfo } from '../../core/config/userdata.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { perfNow } from '../../core/logging/perf.js';
import { globalProfiler } from '../../core/logging/perf.js';
import type { IPerfMonitorExportManager } from './IPerfMonitorPanelComponents.js';

export class PerfMonitorExportManager implements IPerfMonitorExportManager {
  private _webviewPerfData: Array<{ name: string; duration: number }> = [];
  private _data: any[] = [];
  private _context: vscode.ExtensionContext;
  private _onFileCreated?: (path: string) => void;

  constructor(context: vscode.ExtensionContext, onFileCreated?: (path: string) => void) {
    this._context = context;
    this._onFileCreated = onFileCreated;
  }

  setWebviewPerfData(data: Array<{ name: string; duration: number }>): void {
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
      const combinedFunctionCalls = [
        ...(captureResult?.functionCalls || []),
        ...this._webviewPerfData.map((d: any) => ({
          name: d.name,
          start: 0,
          duration: d.duration,
        })),
      ];
      const combinedResult = { ...captureResult, functionCalls: combinedFunctionCalls };
      const json = {
        schemaVersion: '2.0',
        environment: {
          nodeVersion: process.version,
          vscodeVersion: vscode.version,
          platform: process.platform,
          extensionVersion: '0.0.2',
        },
        exportedAt: new Date().toISOString(),
        exportedAtEpochMs: Date.now(),
        monitoringData: this._data || [],
        // 캡처 원본(샘플)과 전체 분석 결과
        capture: {
          duration: combinedResult.duration,
          samples: combinedResult.samples,
        },
        analysis: combinedResult.analysis,
        // 편의상 최상위에 핵심 분석 포인터도 복제해 둠(툴링에서 바로 접근)
        functionCalls: combinedResult.functionCalls || [],
        ioMetrics: (combinedResult.analysis && combinedResult.analysis.ioMetrics) || [],
        ioAnalysis: (combinedResult.analysis && combinedResult.analysis.ioAnalysis) || {},
        summary: {
          totalMonitoringSamples: (this._data || []).length,
          captureDuration: combinedResult.duration,
          avgCpuUser:
            (this._data || []).reduce((sum: number, d: any) => sum + d.cpu.user, 0) /
              (this._data || []).length || 0,
          avgCpuSystem:
            (this._data || []).reduce((sum: number, d: any) => sum + d.cpu.system, 0) /
              (this._data || []).length || 0,
          maxMemory: Math.max(...(this._data || []).map((d: any) => d.memory.heapUsed)),
          minMemory: Math.min(...(this._data || []).map((d: any) => d.memory.heapUsed)),
          // I/O 총괄 요약도 함께
          totalIOOperations:
            (combinedResult.analysis && combinedResult.analysis.ioAnalysis?.totalOperations) || 0,
          totalIOTimeMs:
            (combinedResult.analysis && combinedResult.analysis.ioAnalysis?.totalIOTime) || 0,
        },
      };

      log.info('Getting workspace info using resolveWorkspaceInfo');
      const workspaceInfo = await resolveWorkspaceInfo(this._context);
      const workspaceFolder = { uri: workspaceInfo.wsDirUri };
      log.info(`User workspace folder: ${workspaceFolder.uri.fsPath}`);

      // .debug/perf 아래에 보존 (빌드 산출물과 구분되며, perf 폴더는 클린 대상에서 제외 가정)
      const perfFolderUri = vscode.Uri.joinPath(workspaceFolder.uri, '.debug', 'perf');
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
      // 더 알아보기 쉬운 파일명
      const filename = `perf-monitor-${timestamp}.json`;
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
      const perfFolderUri = vscode.Uri.joinPath(workspaceFolder.uri, 'out', 'perf');

      try {
        await vscode.workspace.fs.stat(perfFolderUri);
      } catch {
        await vscode.workspace.fs.createDirectory(perfFolderUri);
      }

      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `perf-monitor-${timestamp}-report.html`;
      const fileUri = vscode.Uri.joinPath(perfFolderUri, filename);

      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(html, 'utf8'));

      // 파일 생성 후 콜백 호출 (explorer 갱신용)
      this._onFileCreated?.(fileUri.fsPath);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to export HTML report: ${error}`);
    }
  }
}
