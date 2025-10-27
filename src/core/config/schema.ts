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
 *  - file: string  (단일 "베이스네임 토큰 + {로테이션}" 지정)
 *      · 예: "system.log.{n}", "clip.log.{:2}", "otbr-agent.{1}", "cpcd.log.{0}", "homey-pro.{n}"
 *      · {} 지정자:
 *          - {n}  : 베이스 및 모든 로테이션(.1, .2, …)
 *          - {0}  : 베이스만(확장자 유무 무관)
 *          - {k}  : 숫자 k 로테이션만
 *          - {:k} : 베이스부터 .k 까지 포함
 *      · "^"로 시작하면 정규식으로 간주(그대로 사용, 매칭 대상은 basename)
 *  - need: boolean (true일 때만 파싱 대상에 포함)
 *  - regex: { time, process, pid, message } (각 항목 개별 캡처 정규식)
 * ───────────────────────────────────────────────────────────── */
export type ParserFieldRegex = {
  time?: string;
  process?: string;
  pid?: string;
  message?: string;
};
export type ParserRule = {
  /** 파일명 토큰: "<base>.{n|0|k|:k}" 또는 "^" 시작 정규식(베이스네임 기준) */
  file: string;
  need?: boolean;
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
