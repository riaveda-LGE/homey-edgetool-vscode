// === src/extension/editors/IPerfMonitorPanelComponents.ts ===
import * as vscode from 'vscode';

export interface PerfData {
  timestamp: string;
  cpu: NodeJS.CpuUsage;
  memory: NodeJS.MemoryUsage;
  responseTime?: number;
}

export interface IPerfMonitorCaptureManager {
  startCapture(): void;
  stopCapture(): void;
  isCapturing: boolean;
  addWebviewPerfData(name: string, duration: number): void;
}

export interface IPerfMonitorExportManager {
  exportJson(): Promise<void>;
  exportDisplayedHtml(html: string): Promise<void>;
}

export interface IPerfMonitorHtmlGenerator {
  generateHtmlReport(result: any, isForWebview?: boolean): string;
  getHtmlForWebview(webview: vscode.Webview): string;
}

export interface IPerfMonitorMessageHandler {
  handleMessage(message: any): void;
}
