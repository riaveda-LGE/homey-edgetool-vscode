// 공용 상수 모음 (Node/VSCode 런타임 모두에서 사용)

// Extension 식별자
export const EXTENSION_PUBLISHER = 'lge' as const;
export const EXTENSION_NAME = 'homey-edgetool' as const;
export const EXTENSION_ID = `${EXTENSION_PUBLISHER}.${EXTENSION_NAME}` as const;

export const ACTIVITY_CONTAINER_ID = 'homey-edge' as const;
export const PANEL_VIEW_TYPE = 'edgePanel' as const;

// Logger
export const LOG_CHANNEL_NAME = 'Homey EdgeTool' as const;
export const LOG_LEVEL_DEFAULT = 'debug' as const; // 'debug' | 'info' | 'warn' | 'error'
export const LOG_MAX_BUFFER = 500;
export const LOG_FLUSH_INTERVAL_MS = 80;
export const LOG_IGNORE_KEYWORDS = [
  'copilot-chat',
  'copilot',
  'undici',
  'typescript-language-features',
] as const;

// Updater / GitHub
export const GH_OWNER = 'riaveda-LGE' as const;
export const GH_REPO = 'homey-edgetool-vscode' as const;
export const LATEST_JSON_URL = `https://github.com/${GH_OWNER}/${GH_REPO}/releases/latest/download/latest.json`;

export const FETCH_JSON_TIMEOUT_MS = 12_000;
export const FETCH_BUFFER_TIMEOUT_MS = 60_000;

// Webview/Panel
export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_TRANSFER_TIMEOUT_MS = 60_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_SSH_PORT = 65535;
export const MIN_SSH_PORT = 1;

// Logs & Buffers
export const DEFAULT_BATCH_SIZE = 200;
export const REALTIME_BUFFER_MAX = 1000;
export const PERF_DATA_MAX = 1000;
export const LOG_TOTAL_CALLS_THRESHOLD = 1000;

/** workspace 하위의 raw 디렉터리명 */
export const RAW_DIR_NAME = 'raw';
/** 병합 결과 저장 디렉터리명 (raw 하위에 생성) */
export const MERGED_DIR_NAME = 'merge_log';
/** 병합 manifest 파일명 */
export const MERGED_MANIFEST_FILENAME = 'manifest.json';
/** 병합 결과 한 청크의 최대 라인 수 */
export const MERGED_CHUNK_MAX_LINES = 5000;
/** PagedReader 기본 페이지 크기(웹뷰가 별도 지정하지 않으면) */
export const PAGED_READER_DEFAULT_PAGE_SIZE = 500;

// (warmup 관련 플래그/리밋은 featureFlags.ts로 일원화)

/* ──────────────────────────────────────────────────────────────
 * Log Viewer 공통 상수(Host/Webview 공용) — 가상 스크롤 윈도우
 * ────────────────────────────────────────────────────────────── */
/** 웹뷰 한 번에 유지할 최대 행 수 (윈도우 크기) */
export const LOG_WINDOW_SIZE = 200;
/** 1행의 기준 높이(px) — 가상 스크롤 계산에 사용 */
export const LOG_ROW_HEIGHT = 22;
/** 오버스캔(위/아래 미리 로드) 행 수 */
export const LOG_OVERSCAN = 40;

// UI & Misc
export const PERF_UPDATE_INTERVAL_MS = 1000;
export const RANDOM_STRING_LENGTH = 32;

// Parser config/template
// 워크스페이스 내 배치 파일명
export const PARSER_CONFIG_REL = '.config/custom_log_parser.json';
export const PARSER_README_REL = '.config/custom_log_parser_readme.md';
// 확장 내 내장 템플릿/문서 경로
export const PARSER_TEMPLATE_REL = 'media/resources/custom_log_parser.template.v1.json';
export const PARSER_README_TEMPLATE_REL = 'doc/logging-0-parser.md';
