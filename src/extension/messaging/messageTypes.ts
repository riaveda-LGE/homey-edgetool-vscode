// 공용 메시지 타입 (Host <-> Webview)
export type LogEntry = {
  id: number;
  ts: number; // epoch ms
  level?: 'D' | 'I' | 'W' | 'E';
  type?: 'system' | 'homey' | 'application' | 'other';
  source?: string;
  text: string;
};

export type Envelope<TType extends string, TPayload> = {
  v: 1;
  id?: string; // 요청-응답 상관관계용 (선택)
  type: TType;
  payload: TPayload;
  abortKey?: string; // 취소 그룹 키(선택)
};

// 빈 payload를 나타내기 위한 타입
type EmptyPayload = Record<string, never>;

// Host → Webview
export type H2W =
  | Envelope<'logs.batch', { logs: LogEntry[]; total?: number; seq?: number }>
  | Envelope<
      'metrics.update',
      {
        buffer: { realtime: number; viewport: number; search: number; spill: number };
        mem: { rss: number; heapUsed: number };
      }
    >
  | Envelope<'connection.status', { state: 'connected' | 'disconnected'; host: string }>
  | Envelope<'update.available', { version: string }>
  | Envelope<'error', { code: string; message: string; detail?: any; inReplyTo?: string }>;

// Webview → Host
export type W2H =
  | Envelope<'ui.ready', EmptyPayload>
  | Envelope<'logging.startRealtime', { filter?: string; files?: string[] }>
  | Envelope<'logging.startFileMerge', { dir: string; types?: string[]; reverse?: boolean }>
  | Envelope<'logging.stop', EmptyPayload>
  | Envelope<'search.query', { q: string; regex?: boolean; range?: [number, number]; top?: number }>
  | Envelope<'homey.command.run', { name: string; args?: string[] }>;
