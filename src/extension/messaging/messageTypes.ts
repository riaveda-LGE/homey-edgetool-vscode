// 공용 메시지 타입 (Host <-> Webview). 나중에 webview 번들에서도 import 하도록 경로 공유 권장.
export type LogEntry = {
  id: number;
  ts: number;     // epoch ms
  level?: 'D'|'I'|'W'|'E';
  type?: 'system'|'homey'|'application'|'other';
  source?: string;
  text: string;
};

export type Envelope<TType extends string, TPayload> = {
  v: 1;
  id?: string;            // 요청-응답 상관관계용 (선택)
  type: TType;
  payload: TPayload;
  abortKey?: string;      // 취소 그룹 키(선택)
};

// Host → Webview
export type H2W =
  | Envelope<'logs.batch',         { logs: LogEntry[]; total?: number; seq?: number }>
  | Envelope<'metrics.update',     { buffer: {realtime:number; viewport:number; search:number; spill:number}; mem:{rss:number; heapUsed:number} }>
  | Envelope<'connection.status',  { state: 'connected'|'disconnected'; host: string }>
  | Envelope<'update.available',   { version: string }>
  | Envelope<'error',              { code: string; message: string; detail?: any; inReplyTo?: string }>;

// Webview → Host
export type W2H =
  | Envelope<'ui.ready',           { }>
  | Envelope<'logging.startRealtime',{ filter?: string; files?: string[] }>
  | Envelope<'logging.startFileMerge',{ dir: string; types?: string[]; reverse?: boolean }>
  | Envelope<'logging.stop',       { }>
  | Envelope<'search.query',       { q: string; regex?: boolean; range?: [number,number]; top?: number }>
  | Envelope<'homey.command.run',  { name: string; args?: string[] }>;
