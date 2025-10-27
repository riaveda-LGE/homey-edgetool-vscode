// Host ↔ Webview 공용 메시지 타입 (런타임 의존 없음: 타입만 정의)

export type ParsedPayload = {
  /** 대괄호 제거 등 최소 정규화된 원문 토큰 */
  time?: string | null;
  process?: string | null;
  pid?: string | null;
  message?: string | null;
};

export type LogEntry = {
  id: number;
  /**
   * 전역 인덱스(오름차순, 과거=1, 최신=total).
   * - 파일 병합/페이지 서비스 단계에서 부여됨
   * - UI/브리지는 항상 이 오름차순 좌표계를 사용
   */
  idx?: number;
  ts: number; // epoch ms
  level?: 'D' | 'I' | 'W' | 'E';
  type?: 'system' | 'homey' | 'application' | 'other';
  /**
   * 표시/검색용 소스 정보(과거 호환):
   * - 이전엔 파일 타입키나 파일명을 혼용해 담겼음
   * - 이제는 파일명이 `file`에 들어가므로, `source`는 보조 정보(백워드 호환)
   */
  source?: string;
  /** 파일 basename (예: 'homey-pro.log' / 'kernel.log.1') */
  file?: string;
  /** 파일 경로(알 수 없으면 basename 또는 상대경로가 들어갈 수 있음) */
  path?: string;
  /** (선택) 파싱된 필드 – 일부 소스에만 존재 */
  pid?: string | number;
  process?: string;
  text: string;
  /** 파싱 결과 원문 필드(테스트/필터/검색용) */
  parsed?: ParsedPayload;
  /** 병합 타이브레이커 메타(내부용) */
  _fRank?: number;
  _rev?: number;
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
  id?: string; // 요청-응답 상관관계용(선택)
  type: TType;
  payload: TPayload;
  abortKey?: string; // 취소 그룹 키(선택)
};

type Empty = Record<string, never>;

// 병합 저장 완료 payload(공용 타입)
export type MergeSavedInfo = {
  outDir: string;
  manifestPath: string;
  chunkCount: number;
  total?: number;
  merged: number;
};

// ── 서버측 필터 모델 ────────────────────────────────────────────────────────
export type LogFilter = {
  pid?: string;
  src?: string; // 파일/소스
  proc?: string; // 프로세스명
  msg?: string; // 메시지
};

// Host → Webview
export type H2W =
  | Envelope<'logs.batch', { logs: LogEntry[]; total?: number; seq?: number; version?: number }>
  | Envelope<
      'logs.page.response',
      {
        /** 요청/응답 모두 오름차순 인덱스(과거=1, 최신=total) 기준 */
        startIdx: number;
        endIdx: number;
        logs: LogEntry[];
        version?: number;
      }
    >
  /** 현재 pagination/데이터 상태 스냅샷(디버깅/부팅용) */
  | Envelope<
      'logs.state',
      { warm: boolean; total?: number; version?: number; manifestDir?: string }
    >
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
  | Envelope<'perf.captureStarted', Empty>
  | Envelope<'perf.captureStopped', { result: any; htmlReport: string; exportHtml: string }>
  | Envelope<'perf.monitoringStarted', Empty>
  | Envelope<'perf.monitoringStopped', Empty>
  | Envelope<
      'explorer.list.result',
      { path: string; items: { name: string; kind: 'file' | 'folder' }[] }
    >
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
  /** Debug Log Panel 페이징 응답(오래된 로그 프리펜드) */
  | Envelope<'debuglog.page.response', { lines: string[]; cursor: number; total: number }>
  /** Debug Log Panel 전체 삭제 완료 통지 */
  | Envelope<'debuglog.cleared', Empty>
  /** Debug Log Panel 전체 복사 완료(선택적 통계) */
  | Envelope<'debuglog.copy.done', { bytes?: number; lines?: number }>
  /** 파일 병합 저장 완료/정보 */
  | Envelope<'logmerge.saved', MergeSavedInfo>
  /** 병합 진행률(증분/완료) */
  | Envelope<
      'merge.progress',
      { inc?: number; total?: number; done?: number; active?: boolean; reset?: boolean }
    >
  /** 병합 단계 알림(시작/완료/안내 텍스트) */
  | Envelope<'merge.stage', { text: string; kind?: 'start' | 'done' | 'info'; at?: number }>

  /** 사용자 환경설정 전달 */
  | Envelope<'prefs.data', { prefs: any }>
  /** 단순 확인 응답(예: saveUserPrefs ack) */
  | Envelope<'ack', { inReplyTo?: string }>
  /** 정식 병합 완료 후 UI 하드리프레시 트리거(중복/정렬 반영) */
  | Envelope<
      'logs.refresh',
      {
        reason?:
          | 'full-reindex'
          | 'manifest-updated'
          | 'filter-changed'
          | 'bridge.start'
          | 'viewer.ready';
        total?: number;
        version?: number;
        warm?: boolean;
      }
    >
  | Envelope<'search.results', { hits: { idx: number; text: string }[]; q: string }>;

// Webview → Host
export type W2H =
  | Envelope<'viewer.ready', Empty>
  | Envelope<'ui.ready', Empty>
  | Envelope<
      'ui.log',
      { level: 'debug' | 'info' | 'warn' | 'error'; text: string; source?: string }
    >
  /** EdgePanel UI 상태 저장 */
  | Envelope<'ui.savePanelState', { panelState: any }>
  | Envelope<'logging.startRealtime', { filter?: string; files?: string[] }>
  | Envelope<'logging.startFileMerge', { dir: string; types?: string[]; reverse?: boolean }>
  | Envelope<'logging.stop', Empty>
  | Envelope<'logs.page.request', { startIdx: number; endIdx: number }>
  /** 서버측 필터 적용/해제(단일 API, null=해제) */
  | Envelope<'logs.filter.set', { filter: LogFilter | null }>
  | Envelope<'search.query', { q: string; regex?: boolean; range?: [number, number]; top?: number }>
  | Envelope<'search.clear', Empty>
  | Envelope<'homey.command.run', { name: string; args?: string[] }>
  | Envelope<'button.click', { id: string }>
  | Envelope<'perfMeasure', { name: string; duration: number }>
  | Envelope<'perf.startCapture', Empty>
  | Envelope<'prefs.load', Empty>
  | Envelope<'prefs.save', { prefs: any }>
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
  /** Debug Log Panel: 상단 스크롤 시 이전 로그 요청 */
  | Envelope<'debuglog.loadOlder', { limit?: number }>
  /** Debug Log Panel: 전체 삭제 */
  | Envelope<'debuglog.clear', Empty>
  /** Debug Log Panel: 전체 복사(클립보드) */
  | Envelope<'debuglog.copy', Empty>;
