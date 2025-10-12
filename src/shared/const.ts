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
export const READY_MARKER = '%READY%' as const;
