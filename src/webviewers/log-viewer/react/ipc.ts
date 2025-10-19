import { z } from 'zod';
import { useLogStore } from './store';
// ⛔️ host utils가 아니라 webview 전용 utils를 사용해야 함
import { createUiLog } from '../../shared/utils';

declare const acquireVsCodeApi: () => {
  postMessage: (m: any) => void;
  getState?: () => any;
  setState?: (s: any) => void;
};

export const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
const ui = createUiLog(vscode, 'log-viewer-react');

const Env = z.object({ v: z.literal(1), type: z.string(), payload: z.any().optional() });
const ZLogEntry = z.object({
  id: z.number().optional(),
  idx: z.number().optional(),
  ts: z.number().optional(),
  level: z.enum(['D','I','W','E']).optional(),
  type: z.string().optional(),
  source: z.string().optional(),
  text: z.string(),
});

// 현재 세션(version) 추적: host가 logs.refresh로 알려주는 버전 값과 맞지 않으면
// logs.page.response(구버전)를 무시해 UI 일관성을 지킵니다.
let CURRENT_SESSION_VERSION: number | undefined;

// 필터 전송 gate: warmup/초기 배치 수신 전에는 필터 변경을 보류
let READY_FOR_FILTER = false;
let PENDING_FILTER: { pid: string; src: string; proc: string; msg: string } | null = null;
function setReadyForFilter() {
  if (!READY_FOR_FILTER) {
    READY_FOR_FILTER = true;
    ui.info('filter: ready — flushing any pending filter');
    if (PENDING_FILTER) flushFilter(PENDING_FILTER);
    PENDING_FILTER = null;
  }
}

export function setupIpc() {
  ui.info('ipc.setupIpc: start');
  // 1) 사용자 환경설정 요청
  vscode?.postMessage({ v:1, type:'logviewer.getUserPrefs', payload:{} });
  // 2) 최신 브리지와의 핸드셰이크 (hostWebviewBridge가 viewer.ready를 대기)
  vscode?.postMessage({ v:1, type:'viewer.ready', payload:{} } as any);

  window.addEventListener('message', (ev) => {
    const parsed = Env.safeParse(ev.data);
    if (!parsed.success) return;
    const { type, payload } = parsed.data;

    switch (type) {
      case 'logs.state': {
        // host 쪽 pagination 상태 스냅샷(디버깅/초기 배너/프로그레스 용)
        const total = typeof payload?.total === 'number' ? payload.total : undefined;
        const version = typeof payload?.version === 'number' ? payload.version : undefined;
        const warm = !!payload?.warm;
        CURRENT_SESSION_VERSION = version ?? CURRENT_SESSION_VERSION;
        ui.info(`logs.state: warm=${warm} total=${total ?? 'unknown'} version=${version ?? 'n/a'}`);
        if (warm) setReadyForFilter();
        if (typeof total === 'number') useLogStore.getState().setTotalRows(total);
        return;
      }
      case 'logviewer.prefs': {
        const p = (payload?.prefs ?? {}) as any;
        if (typeof p.showTime === 'boolean') useLogStore.getState().toggleColumn('time', !!p.showTime);
        if (typeof p.showProc === 'boolean') useLogStore.getState().toggleColumn('proc', !!p.showProc);
        if (typeof p.showPid  === 'boolean') useLogStore.getState().toggleColumn('pid',  !!p.showPid);
        if (typeof p.showSrc  === 'boolean') useLogStore.getState().toggleColumn('src',  !!p.showSrc);
        if (typeof p.showMsg  === 'boolean') useLogStore.getState().toggleColumn('msg',  !!p.showMsg);
        if (typeof p.bookmarksOpen === 'boolean') {
          const want = !!p.bookmarksOpen;
          const cur = useLogStore.getState().showBookmarks;
          if (cur !== want) useLogStore.getState().toggleBookmarksPane();
        }
        return;
      }
      case 'logs.batch': {
        const logs = z.array(ZLogEntry).parse(payload?.logs ?? []);
        const total = typeof payload?.total === 'number' ? payload.total : undefined;
        if (typeof total === 'number') useLogStore.getState().setTotalRows(total);
        let nextId = useLogStore.getState().nextId;
        const rows = logs.map(e => {
          const raw = String(e.text ?? '');
          const p = parseLine(raw);
          return { id: nextId++, idx: e.idx, ...p, src: String(e?.source ?? ''), raw };
        });
        ui.debug?.(`logs.batch: recv=${rows.length} total=${total ?? 'n/a'}`);
        useLogStore.getState().receiveRows(1, rows);
        setReadyForFilter(); // 최초 배치 수신 시 필터 전송 허용
        return;
      }
      case 'logs.refresh': {
        const total = Number(payload?.total ?? 0) || 0;
        const version = typeof payload?.version === 'number' ? payload.version : undefined;
        const warm = !!payload?.warm;
        CURRENT_SESSION_VERSION = version ?? CURRENT_SESSION_VERSION;
        ui.info(`logs.refresh: reason=${payload?.reason ?? ''} warm=${warm} total=${total} version=${version ?? 'n/a'}`);
        useLogStore.getState().setTotalRows(total);
        setReadyForFilter(); // 풀 리인덱스 이후에도 허용
        useLogStore.getState().receiveRows(1, []);
        const startIdx = 1;
        const size = useLogStore.getState().windowSize || 500;
        const endIdx = Math.max(1, Math.min(total || size, size));
        ui.info(`refresh: request first page ${startIdx}-${endIdx} total=${total}`);
        vscode?.postMessage({ v:1, type:'logs.page.request', payload:{ startIdx, endIdx }});
        return;
      }
      case 'logs.page.response': {
        const startIdx = Number(payload?.startIdx) || 1;
        const respVersion = typeof payload?.version === 'number' ? payload.version : undefined;
        if (typeof respVersion === 'number' && typeof CURRENT_SESSION_VERSION === 'number' && respVersion !== CURRENT_SESSION_VERSION) {
          ui.warn(`page.response: IGNORE stale version resp=${respVersion} current=${CURRENT_SESSION_VERSION}`);
          return;
        }
        const items = z.array(ZLogEntry).parse(payload?.logs ?? []);
        let nextId = useLogStore.getState().nextId;
        const rows = items.map(e => {
          const raw = String(e.text ?? '');
          const p = parseLine(raw);
          return { id: nextId++, idx: e.idx, ...p, src: String(e?.source ?? ''), raw };
        });
        ui.debug(`page: response ${startIdx}-${payload?.endIdx} count=${rows.length}`);
        useLogStore.getState().receiveRows(startIdx, rows);
        return;
      }
      case 'merge.progress': {
        useLogStore.getState().mergeProgress({
          inc:   typeof payload?.inc   === 'number' ? payload.inc   : undefined,
          total: typeof payload?.total === 'number' ? payload.total : undefined,
          active: typeof payload?.active === 'boolean' ? payload.active : undefined
        });
        return;
      }
      case 'logmerge.saved': {
        const total =
          (typeof payload?.total === 'number' ? payload.total : undefined) ??
          (typeof payload?.merged === 'number' ? payload.merged : undefined);
        if (typeof total === 'number') {
          const need = Math.max(0, total - useLogStore.getState().mergeDone);
          useLogStore.getState().mergeProgress({ inc: need, total, active: false });
          useLogStore.getState().setTotalRows(total);
        } else {
          useLogStore.getState().mergeProgress({ inc: 0, active: false });
        }
        return;
      }
      case 'search.results': {
        const hits = (payload?.hits ?? []).map((h: any)=>({ idx: Number(h?.idx)||0, text: String(h?.text||'') }));
        ui.info(`search.results recv hits=${hits.length}`);
        useLogStore.getState().setSearchResults(hits);
        return;
      }
      case 'error': {
        ui.error(`host-error: ${String(payload?.code ?? '')} ${String(payload?.message ?? '')}`);
        return;
      }
    }
  });
}

function parseLine(line: string){
  const timeMatch = line.match(/^\[([^\]]+)\]\s+(.*)$/);
  let time = '', rest = line;
  if (timeMatch){ time = timeMatch[1]; rest = timeMatch[2]; }
  const procMatch = rest.match(/^([^\s:]+)\[(\d+)\]:\s*(.*)$/);
  let proc='', pid='', msg=rest;
  if (procMatch){ proc = procMatch[1]; pid = procMatch[2]; msg = procMatch[3] ?? ''; }
  return { time, proc, pid, msg };
}

// 호스트로 필터 변경을 보냅니다(필요 시 컴포넌트에서 호출).
export function postFilterUpdate(filter: { pid?: string; src?: string; proc?: string; msg?: string }) {
  const next = normalizeFilter(filter);
  if (!READY_FOR_FILTER) {
    PENDING_FILTER = next;
    ui.info(`filter.update deferred (viewer not ready): ${JSON.stringify(next)}`);
    return;
  }
  flushFilter(next);
}

function normalizeFilter(f: any){
  const s = (v:any)=> String(v ?? '').trim();
  const pid  = s(f?.pid);
  const src  = s(f?.src);
  const proc = s(f?.proc);
  const msg  = s(f?.msg);
  return { pid, src, proc, msg };
}

function flushFilter(next: { pid: string; src: string; proc: string; msg: string }) {
  const payload = { filter: next };
  ui.info(`filter.update → host ${JSON.stringify(payload.filter)}`);
  vscode?.postMessage({ v:1, type:'logs.filter.update', payload });
}
