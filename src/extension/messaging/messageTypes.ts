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
  | Envelope<
      'buttons.set',
      { sections: { title: string; items: { id: string; label: string; desc?: string }[] }[] }
    >
  | Envelope<'ui.toggleMode', { toggle?: boolean; mode?: 'mode-normal' | 'mode-debug' }>
  | Envelope<'error', { code: string; message: string; detail?: any; inReplyTo?: string }>
  | Envelope<'perf.updateData', { data: any[] }>
  | Envelope<'perf.captureStarted', EmptyPayload>
  | Envelope<'perf.captureStopped', { result: any; htmlReport: string; exportHtml: string }>
  | Envelope<'perf.monitoringStarted', EmptyPayload>
  | Envelope<'perf.monitoringStopped', EmptyPayload>
  ;

// Webview → Host
export type W2H =
  | Envelope<'ui.ready', EmptyPayload>
  | Envelope<
      'ui.log',
      { level: 'debug' | 'info' | 'warn' | 'error'; text: string; source?: string }
    >
  | Envelope<'logging.startRealtime', { filter?: string; files?: string[] }>
  | Envelope<'logging.startFileMerge', { dir: string; types?: string[]; reverse?: boolean }>
  | Envelope<'logging.stop', EmptyPayload>
  | Envelope<'search.query', { q: string; regex?: boolean; range?: [number, number]; top?: number }>
  | Envelope<'homey.command.run', { name: string; args?: string[] }>
  | Envelope<'button.click', { id: string }>
  | Envelope<'perfMeasure', { name: string; duration: number }>
  | Envelope<'perf.startCapture', EmptyPayload>
  | Envelope<'perf.stopCapture', EmptyPayload>
  | Envelope<'perf.startMonitoring', EmptyPayload>
  | Envelope<'perf.stopMonitoring', EmptyPayload>
  | Envelope<'perf.exportJson', EmptyPayload>
  | Envelope<'perf.exportHtmlReport', { html: string }>
  ;
