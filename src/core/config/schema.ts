// === src/core/config/schema.ts ===
export type ConnectionSchema =
  | { type: 'ssh'; host: string; port?: number; user?: string; keyPath?: string; password?: string }
  | { type: 'adb'; serial?: string };

export type Timeouts = { sshMs?: number; adbMs?: number; tarPhaseMs?: number };
export type BufferConfig = { maxRealtime?: number };

export type AppConfig = {
  connection?: ConnectionSchema;
  timeouts?: Timeouts;
  buffer?: BufferConfig;
};

export const defaultConfig: AppConfig = {
  timeouts: { sshMs: 15000, adbMs: 15000, tarPhaseMs: 60000 },
  buffer: { maxRealtime: 2000 },
};
