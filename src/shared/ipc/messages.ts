// === src/shared/ipc/messages.ts ===
// Host ↔ Webview 공용 메시지 타입 (런타임 의존 없음: 타입만 정의)

export type LogEntry = {
  id: number;
  /** 전역 인덱스(최신=1). 파일 병합 세션에서만 부여됨 */
  idx?: number;
  ts: number; // epoch ms
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
  id?: string;       // 요청-응답 상관관계용(선택)
  type: TType;
  payload: TPayload;
  abortKey?: string; // 취소 그룹 키(선택)
};

type Empty = Record<string, never>;

// Host → Webview
export type H2W =
  | Envelope<'logs.batch', { logs: LogEntry[]; total?: number; seq?: number }>
  | Envelope<'logs.page.response', { startIdx: number; endIdx: number; logs: LogEntry[] }>
  | Envelope<'metrics.update', {
      buffer: { realtime: number; viewport: number; search: number; spill: number };
      mem: { rss: number; heapUsed: number };
    }>
  | Envelope<'connection.status', { state: 'connected' | 'disconnected'; host: string }>
  | Envelope<'update.available', { version: string }>
  | Envelope<'buttons.set', { sections: { title: string; items: { id: string; label: string; desc?: string }[] }[] }>
  | Envelope<'ui.toggleMode', { toggle?: boolean; mode?: 'mode-normal' | 'mode-debug' }>
  | Envelope<'error', { code: string; message: string; detail?: any; inReplyTo?: string }>
  | Envelope<'perf.updateData', { data: any[] }>
  | Envelope<'perf.captureStarted', Empty>
  | Envelope<'perf.captureStopped', { result: any; htmlReport: string; exportHtml: string }>
  | Envelope<'perf.monitoringStarted', Empty>
  | Envelope<'perf.monitoringStopped', Empty>
  | Envelope<'explorer.list.result', { path: string; items: { name: string; kind: 'file' | 'folder' }[] }>
  | Envelope<'explorer.ok', { op: string; path: string }>
  | Envelope<'explorer.error', { op: string; message: string }>
  | Envelope<'explorer.root.changed', Empty>
  | Envelope<'explorer.fs.changed', { path: string }>
  | Envelope<'appendLog', { text: string }>
  // ⬇️ 웹뷰 쪽에서 optional panelState를 기대하므로 superset으로 정의
  | Envelope<'initState', { state: EdgePanelState; panelState?: any }>
  | Envelope<'setUpdateVisible', { visible: boolean }>
  | Envelope<'ui.toggleExplorer', Empty>
  | Envelope<'ui.toggleLogs', Empty>
  /** 파일 병합 저장 완료/정보 */
  | Envelope<'logmerge.saved', { outDir: string; manifestPath: string; chunkCount: number; total?: number; merged: number }>
  /** 병합 진행률(증분/완료) */
  | Envelope<'merge.progress', { inc?: number; total?: number; done?: number; active?: boolean }>
  /** 사용자 환경설정 전달 */
  | Envelope<'logviewer.prefs', { prefs: any }>
  /** 단순 확인 응답(예: saveUserPrefs ack) */
  | Envelope<'ack', { inReplyTo?: string }>;

// Webview → Host
export type W2H =
  | Envelope<'ui.ready', Empty>
  | Envelope<'ui.log', { level: 'debug' | 'info' | 'warn' | 'error'; text: string; source?: string }>
  | Envelope<'logging.startRealtime', { filter?: string; files?: string[] }>
  | Envelope<'logging.startFileMerge', { dir: string; types?: string[]; reverse?: boolean }>
  | Envelope<'logging.stop', Empty>
  | Envelope<'logs.page.request', { startIdx: number; endIdx: number }>
  | Envelope<'search.query', { q: string; regex?: boolean; range?: [number, number]; top?: number }>
  | Envelope<'homey.command.run', { name: string; args?: string[] }>
  | Envelope<'button.click', { id: string }>
  | Envelope<'perfMeasure', { name: string; duration: number }>
  | Envelope<'perf.startCapture', Empty>
  | Envelope<'perf.stopCapture', Empty>
  | Envelope<'perf.startMonitoring', Empty>
  | Envelope<'perf.stopMonitoring', Empty>
  | Envelope<'perf.exportJson', Empty>
  | Envelope<'perf.exportHtmlReport', { html: string }>
  | Envelope<'workspace.ensure', Empty>
  | Envelope<'explorer.list', { path: string }>
  | Envelope<'explorer.refresh', { path: string }>
  | Envelope<'explorer.open', { path: string }>
  | Envelope<'explorer.createFile', { path: string }>
  | Envelope<'explorer.createFolder', { path: string }>
  | Envelope<'explorer.delete', { path: string; recursive?: boolean; useTrash?: boolean }>
  | Envelope<'ui.toggleExplorer', Empty>
  | Envelope<'ui.toggleLogs', Empty>
  | Envelope<'ui.requestButtons', Empty>
  | Envelope<'perf.ready', Empty>
  | Envelope<'logviewer.getUserPrefs', {}>
  | Envelope<'logviewer.saveUserPrefs', { prefs: any }>;
