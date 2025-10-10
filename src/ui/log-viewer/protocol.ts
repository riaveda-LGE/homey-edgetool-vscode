// === src/ui/log-viewer/protocol.ts ===
export type LogEntry = {
  id: number;
  ts: number;
  level?: 'D'|'I'|'W'|'E';
  type?: 'system'|'homey'|'application'|'other';
  source?: string;
  text: string;
};

export type Envelope<TType extends string, TPayload> = {
  v: 1; id?: string; type: TType; payload: TPayload; abortKey?: string;
};

export type H2W =
  | Envelope<'logs.batch', { logs: LogEntry[]; total?: number; seq?: number }>
  | Envelope<'metrics.update', { buffer: {realtime:number; viewport:number; search:number; spill:number}; mem:{rss:number; heapUsed:number} }>
  | Envelope<'error', { code: string; message: string; detail?: any; inReplyTo?: string }>;

export type W2H =
  | Envelope<'ui.ready', { }>
  | Envelope<'logging.startRealtime',{ filter?: string; files?: string[] }>
  | Envelope<'logging.stop', { }>
  | Envelope<'search.query', { q: string; regex?: boolean; range?: [number,number]; top?: number }>;
