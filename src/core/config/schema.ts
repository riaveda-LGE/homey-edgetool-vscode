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

/* ─────────────────────────────────────────────────────────────
 * Custom Parser Config (workspace .config/custom_log_parser.json)
 *  - files: string[] (glob whitelist)
 *  - regex: { time, process, pid, message } (각 항목 개별 캡처 정규식)
 * ───────────────────────────────────────────────────────────── */
export type ParserFieldRegex = {
  time?: string;
  process?: string;
  pid?: string;
  message?: string;
};
export type ParserRule = {
  files: string[];
  regex: ParserFieldRegex;
};
export type ParserConfig = {
  version?: number;
  requirements?: unknown;
  preflight?: unknown;
  parser: ParserRule[];
};
