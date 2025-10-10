// === src/shared/errors.ts ===
export enum ErrorCategory {
  Connection = 'CONNECTION',
  Permission = 'PERMISSION',
  ToolMissing = 'TOOL_MISSING',
  Path = 'PATH',
  Network = 'NETWORK',
  Timeout = 'TIMEOUT',
  Unknown = 'UNKNOWN',
}

export class XError extends Error {
  constructor(public category: ErrorCategory, message: string, public detail?: any) {
    super(message);
    this.name = `XError/${category}`;
  }
}
