// 웹뷰 번들 독립을 위해 확장 쪽 messageTypes를 복제/축약
export type LogEntry = {
  id: number;
  ts: number;
  level?: 'D' | 'I' | 'W' | 'E';
  type?: 'system' | 'homey' | 'application' | 'other';
  source?: string;
  text: string;
};

export type EdgePanelState = {
  version: string;
  updateAvailable: boolean;
  latestVersion?: string;
  updateUrl?: string;
  latestSha?: string;
  lastCheckTime?: string;
  logs?: string[];
};

export type Envelope<T extends string, P> = {
  v: 1;
  id?: string;
  type: T;
  payload: P;
  abortKey?: string;
};

type Empty = Record<string, never>;

// Host → Webview
export type H2W =
  | Envelope<'logs.batch', { logs: LogEntry[]; total?: number; seq?: number }>
  | Envelope<'buttons.set', { sections: { title: string; items: { id: string; label: string; desc?: string }[] }[] }>
  | Envelope<'appendLog', { text: string }>
  | Envelope<'initState', { state: EdgePanelState; panelState?: any }>
  | Envelope<'ui.toggleExplorer', Empty>
  | Envelope<'ui.toggleLogs', Empty>
  | Envelope<'explorer.list.result', { path: string; items: { name: string; kind: 'file' | 'folder' }[] }>
  | Envelope<'explorer.ok', { op: string; path: string }>
  | Envelope<'explorer.error', { op: string; message: string }>
  | Envelope<'explorer.root.changed', Empty>
  | Envelope<'explorer.fs.changed', { path: string }>
  ;

// Webview → Host
export type W2H =
  | Envelope<'ui.ready', Empty>
  | Envelope<'ui.log', { level: 'debug' | 'info' | 'warn' | 'error'; text: string; source?: string }>
  | Envelope<'button.click', { id: string }>
  | Envelope<'ui.toggleExplorer', Empty>
  | Envelope<'ui.toggleLogs', Empty>
  | Envelope<'ui.requestButtons', Empty>
  | Envelope<'workspace.ensure', Empty>
  | Envelope<'explorer.list', { path: string }>
  | Envelope<'explorer.open', { path: string }>
  | Envelope<'explorer.createFile', { path: string }>
  | Envelope<'explorer.createFolder', { path: string }>
  | Envelope<'explorer.delete', { path: string; recursive?: boolean; useTrash?: boolean }>
  | Envelope<'ui.savePanelState', { panelState: any }>
  ;
