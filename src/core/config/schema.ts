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
export type ParserRequirements = {
  /** 어떤 필드를 "캡처 필수"로 볼지 지정(기본: message=true, 나머지 false) */
  fields?: { time?: boolean; process?: boolean; pid?: boolean; message?: boolean };
};
export type ParserPreflight = {
  /** 각 파일에서 사전 점검으로 읽을 최대 라인 수(기본 200) */
  sample_lines?: number;
  /** 매칭 비율이 이 값 미만이면 커스텀 파서를 비활성화(기본 0.8) */
  min_match_ratio?: number;
  /** 여기 패턴 중 하나라도 샘플에서 매칭되면 커스텀 파서 비활성화 */
  hard_skip_if_any_line_matches?: string[];
};
export type ParserConfig = {
  version?: number;
  requirements?: ParserRequirements;
  preflight?: ParserPreflight;
  parser: ParserRule[];
};
