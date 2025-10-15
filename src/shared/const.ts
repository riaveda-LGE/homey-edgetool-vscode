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

// UI & Misc
export const PERF_UPDATE_INTERVAL_MS = 1000;
export const RANDOM_STRING_LENGTH = 32;
