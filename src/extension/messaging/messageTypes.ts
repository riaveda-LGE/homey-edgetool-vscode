// === src/extension/messaging/messageTypes.ts ===
// 공용 메시지 타입 (Host <-> Webview)
export type LogEntry = {
  id: number;
  /** 전역 인덱스(최신=1). 파일 병합 세션에서만 부여됨 */
  idx?: number;
  ts: number; // epoch ms (보정된 시간; 실시간 세션은 원시 now)
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
  | Envelope<'logs.page.response', { startIdx: number; endIdx: number; logs: LogEntry[] }>
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
  | Envelope<'explorer.list.result', { path: string; items: { name: string; kind: 'file' | 'folder' }[] }>
  | Envelope<'explorer.ok', { op: string; path: string }>
  | Envelope<'explorer.error', { op: string; message: string }>
  | Envelope<'explorer.root.changed', EmptyPayload>
  | Envelope<'explorer.fs.changed', { path: string }>
  | Envelope<'appendLog', { text: string }>
  | Envelope<'initState', { state: EdgePanelState }>
  | Envelope<'setUpdateVisible', { visible: boolean }>
  | Envelope<'ui.toggleExplorer', EmptyPayload>
  | Envelope<'ui.toggleLogs', EmptyPayload>
  /** 파일 병합 저장 완료/정보 */
  | Envelope<'logmerge.saved', { outDir: string; manifestPath: string; chunkCount: number; total?: number; merged: number }>
  /** 병합 진행률(증분/완료) */
  | Envelope<'merge.progress', { inc?: number; total?: number; done?: number; active?: boolean }>
  /** 사용자 환경설정 전달 */
  | Envelope<'logviewer.prefs', { prefs: any }>
  /** 단순 확인 응답(예: saveUserPrefs ack) */
  | Envelope<'ack', { inReplyTo?: string }>
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
  | Envelope<'logs.page.request', { startIdx: number; endIdx: number }>
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
  | Envelope<'workspace.ensure', EmptyPayload>
  | Envelope<'explorer.list', { path: string }>
  | Envelope<'explorer.open', { path: string }>
  | Envelope<'explorer.createFile', { path: string }>
  | Envelope<'explorer.createFolder', { path: string }>
  | Envelope<'explorer.delete', { path: string; recursive?: boolean; useTrash?: boolean }>
  | Envelope<'ui.toggleExplorer', EmptyPayload>
  | Envelope<'ui.toggleLogs', EmptyPayload>
  | Envelope<'ui.requestButtons', EmptyPayload>
  | Envelope<'perf.ready', EmptyPayload>
  | Envelope<'logviewer.getUserPrefs', {}>
  | Envelope<'logviewer.saveUserPrefs', { prefs: any }>
  ;
