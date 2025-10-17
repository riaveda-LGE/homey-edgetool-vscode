// === src/extension/commands/ICommandHandlers.ts ===
export interface ICommandHandlers {
  route(raw: string): Promise<void>;
  help(): Promise<void>;
}
