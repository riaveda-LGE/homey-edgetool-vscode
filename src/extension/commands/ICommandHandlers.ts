// === src/extension/commands/ICommandHandlers.ts ===
export interface ICommandHandlers {
  route(raw: string): Promise<void>;
  help(): Promise<void>;
  loggingStart(): Promise<void>;
  loggingMerge(dir: string): Promise<void>;
  loggingStop(): Promise<void>;
  connectInfo(): Promise<void>;
  connectChange(): Promise<void>;
  hostCommand(cmd: string): Promise<void>;
  gitPassthrough(args: string[]): Promise<void>;
  changeWorkspaceQuick(): Promise<void>;
  openWorkspace(): Promise<void>;
  updateNow(): Promise<void>;
  openHelp(): Promise<void>;
  togglePerformanceMonitoring(): Promise<void>;
}
