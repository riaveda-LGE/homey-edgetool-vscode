// === src/extension/editors/IPerfMonitorComponents.ts ===
import * as vscode from 'vscode';

export interface IPerfMonitorDataManager {
  setPerfMode(enabled: boolean): void;
  isPerfMode(): boolean;
  addPerfData(data: any): void;
  getPerfData(): any[];
  clearPerfData(): void;
}

export interface IPerfMonitorWebviewManager {
  createPanel(): void;
  closePanel(): void;
  updatePanel(): void;
  dispose(): void;
}

export interface IPerfMonitorCommandHandler {
  registerCommands(context: vscode.ExtensionContext): vscode.Disposable[];
}
