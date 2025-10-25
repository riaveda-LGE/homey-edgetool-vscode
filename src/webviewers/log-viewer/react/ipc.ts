import { z } from 'zod';

// ⛔️ host utils가 아니라 webview 전용 utils를 사용해야 함
import { createUiLog, createUiMeasure } from '../../shared/utils';
import { useLogStore } from './store';

declare const acquireVsCodeApi: () => {
  postMessage: (m: any) => void;
  getState?: () => any;
  setState?: (s: any) => void;
};

export const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
const ui = createUiLog(vscode, 'log-viewer-react');
// 웹뷰 성능 계측기 (호스트로 perfMeasure 이벤트 전달)
const measureUi = createUiMeasure(vscode, {
  source: 'log-viewer-react',
  minMs: 1,          // 1ms 이상만 샘플링
  sampleEvery: 5,    // 과도한 전송 방지
});

const Env = z.object({ v: z.literal(1), type: z.string(), payload: z.any().optional() });
const ZLogEntry = z.object({
  id: z.number().optional(),
  idx: z.number().optional(),
  ts: z.number().optional(),
  level: z.enum(['D', 'I', 'W', 'E']).optional(),
  type: z.string().optional(),
  /** 호스트가 주는 표시용 소스(기존). e.g. 'kernel' */
  source: z.string().optional(),
  /** 실제 파일명(또는 경로) — 최신 호스트에서 내려올 수 있음 */
  file: z.string().optional(),
  path: z.string().optional(),
  text: z.string(),
});

// 현재 세션(version) 추적
let CURRENT_SESSION_VERSION: number | undefined;
function updateSessionVersion(next: number | undefined, origin: string) {
  ui.debug?.('[debug] updateSessionVersion: start');
  const prev = CURRENT_SESSION_VERSION;
  if (typeof next === 'number' && next !== prev) {
    CURRENT_SESSION_VERSION = next;
    ui.info(`session.version ← ${next} (prev=${prev ?? 'n/a'}, origin=${origin})`);
  } else {
    ui.debug?.(
      `session.version keep ${prev ?? 'n/a'} (origin=${origin}, next=${next ?? 'n/a'})`,
    );
  }
  ui.debug?.('[debug] updateSessionVersion: end');
}

// 필터 전송 gate: warmup/초기 배치 수신 전에는 필터 변경을 보류
let READY_FOR_FILTER = false;
let PENDING_FILTER: { pid: string; src: string; proc: string; msg: string } | null = null;
function setReadyForFilter() {
  ui.debug?.('[debug] setReadyForFilter: start');
  if (!READY_FOR_FILTER) {
    READY_FOR_FILTER = true;
    ui.info('filter: ready — flushing any pending filter');
    if (PENDING_FILTER) flushFilter(PENDING_FILTER);
    PENDING_FILTER = null;
  }
  ui.debug?.('[debug] setReadyForFilter: end');
}

export function setupIpc() {
  ui.debug?.('ipc.setupIpc: start');
  // 1) 사용자 환경설정 요청
  vscode?.postMessage({ v: 1, type: 'logviewer.getUserPrefs', payload: {} });
  // 2) 최신 브리지와의 핸드셰이크 (hostWebviewBridge가 viewer.ready를 대기)
  vscode?.postMessage({ v: 1, type: 'viewer.ready', payload: {} } as any);

  window.addEventListener('message', (ev) => {
    const parsed = Env.safeParse(ev.data);
    if (!parsed.success) return;
    const { type, payload } = parsed.data;

    return measureUi(`ipc.on:${type}`, () => {
      switch (type) {
      case 'logs.state': {
        // host 쪽 pagination 상태 스냅샷(디버깅/초기 배너/프로그레스 용)
        const total = typeof payload?.total === 'number' ? payload.total : undefined;
        const version = typeof payload?.version === 'number' ? payload.version : undefined;
        const warm = !!payload?.warm;
        updateSessionVersion(version, 'logs.state');
        // 최초 1회만 info, 이후는 debug로 하향
        (setupIpc as any).__stateOnceLogged
          ? ui.debug?.(`logs.state: warm=${warm} total=${total ?? 'unknown'} version=${version ?? 'n/a'}`)
          : ui.info(`logs.state: warm=${warm} total=${total ?? 'unknown'} version=${version ?? 'n/a'}`);
        (setupIpc as any).__stateOnceLogged = true;
        // ⚠️ 과거엔 warm 일 때만 ready. 파일 기반( warm=false ) 초기 클릭이 묵살되는 이슈가 있어
        // 호스트가 살아있다는 신호(logs.state)를 받는 즉시 필터 전송을 허용한다.
        setReadyForFilter();
        if (typeof total === 'number') useLogStore.getState().setTotalRows(total);
        return;
      }
      case 'logviewer.prefs': {
        const p = (payload?.prefs ?? {}) as any;
        if (typeof p.showTime === 'boolean')
          useLogStore.getState().toggleColumn('time', !!p.showTime);
        if (typeof p.showProc === 'boolean')
          useLogStore.getState().toggleColumn('proc', !!p.showProc);
        if (typeof p.showPid === 'boolean') useLogStore.getState().toggleColumn('pid', !!p.showPid);
        if (typeof p.showSrc === 'boolean') useLogStore.getState().toggleColumn('src', !!p.showSrc);
        if (typeof p.showMsg === 'boolean') useLogStore.getState().toggleColumn('msg', !!p.showMsg);
        // 북마크 패널은 시작 시 기본 닫힘.
        // prefs 가 true 라도, 현재 세션에 실제 북마크가 있을 때만 열도록 제한.
        if (typeof p.bookmarksOpen === 'boolean') {
          const want = !!p.bookmarksOpen;
          const hasAny = Object.keys(useLogStore.getState().bookmarks).length > 0;
          useLogStore.getState().setBookmarksPane(want && hasAny);
        }
        return;
      }
      case 'logs.batch': {
        const logs = z.array(ZLogEntry).parse(payload?.logs ?? []);
        const total = typeof payload?.total === 'number' ? payload.total : undefined;
        const v = typeof payload?.version === 'number' ? payload.version : undefined;
        if (typeof total === 'number') useLogStore.getState().setTotalRows(total);
        const baseId = useLogStore.getState().nextId;
        const mapped = measureUi('ipc.logs.batch.map', () => {
          return logs.map((e) => {
            const raw = String(e.text ?? '');
            const p = parseLine(raw);
            const src = pickSrcName(e);
            return { idx: e.idx, ...p, src, raw };
          });
        });
        // ✅ idx 오름차순 정렬 후 id를 정렬 순서대로 부여
        const sorted = mapped.slice().sort((a, b) => (a.idx ?? 0) - (b.idx ?? 0));
        let nextId = baseId;
        const rows = sorted.map((r) => ({ ...r, id: nextId++ }));
        probeRows('batch', rows);
        // ✅ 파일기반 버전만 채택(구버전 seq fallback은 page.response와 충돌 가능)
        if (typeof v === 'number') {
          updateSessionVersion(v, 'logs.batch');
        }

        ui.debug?.(`logs.batch: recv=${rows.length} total=${total ?? 'n/a'} ver=${v ?? 'n/a'}`);
        // 🚩 정렬 이후 첫 원소의 idx를 startIdx로 사용
        const startIdx = rows.length && typeof rows[0].idx === 'number' ? rows[0].idx! : 1;
        useLogStore.getState().receiveRows(startIdx, rows);
        // FOLLOW 모드가 아닐 때는 새 로그 도착을 알림
        if (!useLogStore.getState().follow && rows.length > 0) {
          useLogStore.getState().incNewSincePause();
        }
        setReadyForFilter(); // 최초 배치 수신 시 필터 전송 허용
        return;
      }
      case 'logs.refresh': {
        const total = Number(payload?.total ?? 0) || 0;
        const version = typeof payload?.version === 'number' ? payload.version : undefined;
        const warm = !!payload?.warm;
        updateSessionVersion(version, 'logs.refresh');
        ui.info(
          `logs.refresh: reason=${payload?.reason ?? ''} warm=${warm} total=${total} version=${version ?? 'n/a'}`,
        );
        useLogStore.getState().setTotalRows(total);
        setReadyForFilter(); // 풀 리인덱스 이후에도 허용
        useLogStore.getState().receiveRows(1, []);
        // ✅ 표시 순서는 오름차순, 초기 관심은 최신 → "마지막 페이지"를 요청
        const size = useLogStore.getState().windowSize || 500;
        const endIdx = Math.max(1, total);
        const startIdx = Math.max(1, endIdx - size + 1);
        ui.info(`refresh: request last page ${startIdx}-${endIdx} total=${total}`);
        vscode?.postMessage({ v: 1, type: 'logs.page.request', payload: { startIdx, endIdx } });
        return;
      }
      case 'logs.page.response': {
        const respVersion = typeof payload?.version === 'number' ? payload.version : undefined;
        if (
          typeof respVersion === 'number' &&
          typeof CURRENT_SESSION_VERSION === 'number' &&
          respVersion !== CURRENT_SESSION_VERSION
        ) {
          ui.warn(
            `page.response: IGNORE stale version resp=${respVersion} current=${CURRENT_SESSION_VERSION}`,
          );
          return;
        }
        // 진입 시점에 아직 세션 버전을 모르면(초기 핸드셰이크 경합) 1회 채택
        if (
          typeof respVersion === 'number' &&
          typeof CURRENT_SESSION_VERSION !== 'number'
        ) {
          updateSessionVersion(respVersion, 'logs.page.response(adopt-on-first)');
        }
        const items = z.array(ZLogEntry).parse(payload?.logs ?? []);
        const baseId = useLogStore.getState().nextId;
        const mapped = measureUi('ipc.page.response.map', () => {
          return items.map((e) => {
            const raw = String(e.text ?? '');
            const p = parseLine(raw);
            const src = pickSrcName(e);
            return { idx: e.idx, ...p, src, raw };
          });
        });
        const sorted = mapped.slice().sort((a, b) => (a.idx ?? 0) - (b.idx ?? 0));
        let nextId = baseId;
        const rows = sorted.map((r) => ({ ...r, id: nextId++ }));
        probeRows('page', rows);
        const startIdx = rows.length && typeof rows[0].idx === 'number' ? rows[0].idx! : 1;
        ui.debug?.(`page: response ${startIdx}-${rows.at(-1)?.idx} count=${rows.length} v=${respVersion ?? 'n/a'}`);
        useLogStore.getState().receiveRows(startIdx, rows);
        return;
      }
      case 'merge.progress': {
        useLogStore.getState().mergeProgress({
          inc: typeof payload?.inc === 'number' ? payload.inc : undefined,
          total: typeof payload?.total === 'number' ? payload.total : undefined,
          active: typeof payload?.active === 'boolean' ? payload.active : undefined,
          done: typeof payload?.done === 'number' ? payload.done : undefined,
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
        const hits = (payload?.hits ?? []).map((h: any) => ({
          idx: Number(h?.idx) || 0,
          text: String(h?.text || ''),
        }));
        ui.info(`search.results recv hits=${hits.length}`);
        // q 동기화(+ 닫힘 상태 레이스 방지 로직은 store 쪽에 존재)
        const q = typeof payload?.q === 'string' ? String(payload.q) : undefined;
        useLogStore.getState().setSearchResults(hits, { q });
        return;
      }
      case 'error': {
        ui.error(`host-error: ${String(payload?.code ?? '')} ${String(payload?.message ?? '')}`);
        return;
      }
    }
    });
  });
}

function parseLine(line: string) {
  const timeMatch = line.match(/^\[([^\]]+)\]\s+(.*)$/);
  let time = '',
    rest = line;
  if (timeMatch) {
    time = timeMatch[1];
    rest = timeMatch[2];
  }
  const procMatch = rest.match(/^([^\s:]+)\[(\d+)\]:\s*(.*)$/);
  let proc = '',
    pid = '',
    msg = rest;
  if (procMatch) {
    proc = procMatch[1];
    pid = procMatch[2];
    msg = procMatch[3] ?? '';
  }
  return { time, proc, pid, msg };
}

/**
 * "파일/경로"만을 사용해 표시용 소스를 결정한다.
 * - 우선순위: file → basename(path)
 * - 세그먼트 키 일관성 유지를 위해 source 텍스트에는 의존하지 않는다.
 */
function pickSrcName(e: any): string {
  const file = (typeof e?.file === 'string' && e.file) ? e.file : '';
  const p = (typeof e?.path === 'string' && e.path) ? e.path : '';
  const cand = file || p;
  return basename(cand);
}

function basename(p: string): string {
  if (!p) return '';
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

// 호스트로 필터 변경을 보냅니다(필요 시 컴포넌트에서 호출).
export function postFilterUpdate(filter: {
  pid?: string;
  src?: string;
  proc?: string;
  msg?: string;
}) {
  ui.debug?.('[debug] postFilterUpdate: start');
  const next = measureUi('ipc.normalizeFilter', () => normalizeFilter(filter));
  if (!READY_FOR_FILTER) {
    PENDING_FILTER = next;
    ui.info(`filter.update deferred (viewer not ready): ${JSON.stringify(next)}`);
    ui.debug?.('[debug] postFilterUpdate: end');
    return;
  }
  measureUi('ipc.flushFilter', () => flushFilter(next));
  ui.debug?.('[debug] postFilterUpdate: end');
}

function normalizeFilter(f: any) {
  ui.debug?.('[debug] normalizeFilter: start');
  const s = (v: any) => String(v ?? '').trim();
  const pid = s(f?.pid);
  const src = s(f?.src);
  const proc = s(f?.proc);
  const msg = s(f?.msg);
  ui.debug?.('[debug] normalizeFilter: end');
  return { pid, src, proc, msg };
}

function flushFilter(next: { pid: string; src: string; proc: string; msg: string }) {
  ui.debug?.('[debug] flushFilter: start');
  const payload = { filter: next };
  ui.info(`filter.update → host ${JSON.stringify(payload.filter)}`);
  vscode?.postMessage({ v: 1, type: 'logs.filter.update', payload });
  ui.debug?.('[debug] flushFilter: end');
}

// ────────────── PROBE: 수신 배치 내용 요약 ──────────────
function probeRows(tag: 'batch' | 'page', rows: Array<{idx?: number; time?: string; src?: string}>) {
  const fmt = (r: any) => `${r.idx ?? '?'}|${r.time ?? '-'}|${r.src ?? ''}`;
  const head = rows.slice(0, 5).map(fmt).join(' || ');
  const tail = rows.slice(-5).map(fmt).join(' || ');
  const mono = isMonoAsc(rows.map(r => (typeof r.idx === 'number' ? r.idx : Infinity)));
  ui.info(`[probe:${tag}] rows=len=${rows.length} idxAsc=${mono}`);
  ui.debug?.(`[probe:${tag}] head ${head}`);
  ui.debug?.(`[probe:${tag}] tail ${tail}`);
}
function isMonoAsc(a: number[]) {
  for (let i = 1; i < a.length; i++) if (a[i-1] > a[i]) return false;
  return true;
}
