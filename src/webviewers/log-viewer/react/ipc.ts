import { z } from 'zod';

// ⛔️ host utils가 아니라 webview 전용 utils를 사용해야 함
import { createUiMeasure } from '../../shared/utils';
import { useLogStore } from './store';

declare const acquireVsCodeApi: () => {
  postMessage: (m: any) => void;
  getState?: () => any;
  setState?: (s: any) => void;
};

export const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
// 웹뷰 성능 계측기 (호스트로 perfMeasure 이벤트 전달)
const measureUi = createUiMeasure(vscode, {
  source: 'log-viewer-react',
  minMs: 1, // 1ms 이상만 샘플링
  sampleEvery: 5, // 과도한 전송 방지
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
  // quiet
  const prev = CURRENT_SESSION_VERSION;
  if (typeof next === 'number' && next !== prev) {
    CURRENT_SESSION_VERSION = next;
    // quiet
  } else {
    // quiet
  }
  // quiet
}

// ────────────────────────────────────────────────────────────────────────────
// 추정치(total) 사용 게이트
//  - 병합 전: 진행률 이벤트의 total(추정치)을 UI totalRows에 반영할 수 있음
//  - 병합 완료/파일 기반 전환 후: 추정치 사용을 **금지** (정합성 유지)
//    · 전환 트리거: logs.refresh / merge.stage(kind='done') / logmerge.saved
// ────────────────────────────────────────────────────────────────────────────
let ALLOW_ESTIMATED_TOTAL = true;
function disallowEstimates(reason: string) {
  if (!ALLOW_ESTIMATED_TOTAL) return;
  ALLOW_ESTIMATED_TOTAL = false;
  try {
    console.debug(`[ipc] disable estimated totals: ${reason}`);
  } catch {}
}

// 병합 진행 상태 게이트(완료 후 불필요한 후행 progress 무시)
let MERGE_ACTIVE = false;

// 필터 전송 gate: warmup/초기 배치 수신 전에는 필터 변경을 보류
let READY_FOR_FILTER = false;
let PENDING_FILTER: { pid: string; src: string; proc: string; msg: string } | null = null;
function setReadyForFilter() {
  // quiet
  if (!READY_FOR_FILTER) {
    READY_FOR_FILTER = true;
    // quiet
    if (PENDING_FILTER) flushFilter(PENDING_FILTER);
    PENDING_FILTER = null;
  }
  // quiet
}

export function setupIpc() {
  // quiet
  // 1) 사용자 환경설정 요청
  vscode?.postMessage({ v: 1, type: 'prefs.load', payload: {} });
  // 2) 최신 브리지와의 핸드셰이크 (hostWebviewBridge가 viewer.ready를 대기)
  vscode?.postMessage({ v: 1, type: 'viewer.ready', payload: {} } as any);
  // 3) 기본 모드 확정(명시적으로 '메모리')
  try {
    useLogStore.getState().setMergeMode('memory');
  } catch {}

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
          // 병합 전(워밍업 포함)에는 추정치 허용
          // 최초 1회만 info, 이후는 debug로 하향
          if ((setupIpc as any).__stateOnceLogged) {
            // quiet
          } else {
            // quiet
          }
          (setupIpc as any).__stateOnceLogged = true;
          // ⚠️ 과거엔 warm 일 때만 ready. 파일 기반( warm=false ) 초기 클릭이 묵살되는 이슈가 있어
          // 호스트가 살아있다는 신호(logs.state)를 받는 즉시 필터 전송을 허용한다.
          setReadyForFilter();
          if (typeof total === 'number') useLogStore.getState().setTotalRows(total);
          return;
        }
        case 'prefs.data': {
          const p = (payload?.prefs ?? {}) as any;
          if (typeof p.showTime === 'boolean')
            useLogStore.getState().toggleColumn('time', !!p.showTime);
          if (typeof p.showProc === 'boolean')
            useLogStore.getState().toggleColumn('proc', !!p.showProc);
          if (typeof p.showPid === 'boolean')
            useLogStore.getState().toggleColumn('pid', !!p.showPid);
          if (typeof p.showSrc === 'boolean')
            useLogStore.getState().toggleColumn('src', !!p.showSrc);
          if (typeof p.showMsg === 'boolean')
            useLogStore.getState().toggleColumn('msg', !!p.showMsg);
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

          // quiet
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
          // ✅ 파일 기반 인덱스로 전환된 경우에만 추정치 금지
          // (kickIfReady에서 warm=false 또는 manifestDir 존재 시)
          if (!warm) disallowEstimates('logs.refresh(file-index)');
          // quiet
          useLogStore.getState().setTotalRows(total);
          // 확실히 진행바 닫기
          useLogStore.getState().mergeProgress({ done: total, total, active: false });
          setReadyForFilter(); // 풀 리인덱스 이후에도 허용
          useLogStore.getState().receiveRows(1, []);
          // 모드/스테이지 확정:
          //  - warm=true  → 정식 병합 스킵(메모리 모드에서 완료)
          //  - warm=false → 파일 기반 인덱스로 전환(하이브리드)
          try {
            if (warm) {
              // 스킵 경로: 모드는 계속 'memory' 로 유지
              useLogStore.getState().setMergeMode('memory');
            } else {
              // 정식 병합 완료(파일 인덱스 가용): 하이브리드로 전환
              useLogStore.getState().setMergeMode('hybrid');
            }
            // 표시 스테이지는 공통적으로 '병합 완료'로 고정
            useLogStore.getState().setMergeStage('병합 완료');
          } catch {}
          // ✅ 표시 순서는 오름차순, 초기 관심은 최신 → "마지막 페이지"를 요청
          const size = useLogStore.getState().windowSize || 500;
          const endIdx = Math.max(1, total);
          const startIdx = Math.max(1, endIdx - size + 1);
          // quiet
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
            // 🔎 디버그: 버전 불일치로 드랍된 응답을 기록하여 원인 추적
            try {
              console.debug(
                `[ipc] logs.page.response dropped due to version mismatch: resp=${respVersion} current=${CURRENT_SESSION_VERSION}`,
              );
            } catch {}
            return;
          }
          // 진입 시점에 아직 세션 버전을 모르면(초기 핸드셰이크 경합) 1회 채택
          if (typeof respVersion === 'number' && typeof CURRENT_SESSION_VERSION !== 'number') {
            try {
              console.debug(`[ipc] logs.page.response adopt-on-first resp=${respVersion}`);
            } catch {}
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
          // quiet
          useLogStore.getState().receiveRows(startIdx, rows);
          return;
        }
        case 'merge.progress': {
          // NOTE: 진행률은 Host가 100ms 스로틀링해서 보냄
          // 병합 완료(active=false 또는 done>=total) 이후 도착하는 후행 이벤트는 무시
          const pActive = typeof payload?.active === 'boolean' ? payload.active : undefined;
          const pDone = typeof payload?.done === 'number' ? payload.done : undefined;
          const pTotal = typeof payload?.total === 'number' ? payload.total : undefined;
          const pInc = typeof payload?.inc === 'number' ? payload.inc : undefined;
          const pReset = payload?.reset === true;

          // 닫는 신호 여부 판단
          const isCloseSignal =
            pActive === false || (pTotal && pDone !== undefined && pDone >= pTotal);
          // MERGE_ACTIVE 토글
          if (pActive === true) MERGE_ACTIVE = true;
          if (isCloseSignal) MERGE_ACTIVE = false;
          // 완료 이후의 후행 progress는 드랍하되, 닫는 신호만은 반드시 전달
          if (!MERGE_ACTIVE && pActive !== true && !isCloseSignal) {
            return;
          }
          useLogStore.getState().mergeProgress({
            inc: pInc,
            total: pTotal,
            active: typeof pActive === 'boolean' ? pActive : undefined,
            done: pDone,
            reset: pReset,
          });
          // ⬇️ 총로그수(표시용)도 **병합 전(허용 상태)** 에만 추정값으로 세팅
          try {
            const st = useLogStore.getState();
            if (ALLOW_ESTIMATED_TOTAL && typeof pTotal === 'number') {
              const cur = Number(st.totalRows ?? 0) || 0;
              if (cur === 0 || pTotal > cur) {
                st.setTotalRows(pTotal);
              }
            }
          } catch {}
          return;
        }
        case 'merge.stage': {
          const text = String(payload?.text || '');
          useLogStore.getState().setMergeStage(text);
          // stage 신호 기반으로도 게이트 토글
          const kind = String(payload?.kind || '');
          if (kind === 'start') {
            MERGE_ACTIVE = true;
            // 새 병합 세션 시작 → 추정 total 재허용
            ALLOW_ESTIMATED_TOTAL = true;
          }
          if (kind === 'done') {
            MERGE_ACTIVE = false;
            // 병합 완료 시점부터 추정치 금지
            disallowEstimates('merge.stage(done)');
          }
          // ── 하이브리드 모드로의 전환 트리거 ──
          //  - "파일 병합을 시작" / "로그병합 시작"
          //  - "<type> 로그를 정렬중" (예: "system 로그를 정렬중")
          try {
            const t = text.trim();
            const isHybridSignal =
              t === '파일 병합을 시작' || t === '로그병합 시작' || /로그를\s*정렬중$/.test(t);
            if (isHybridSignal) useLogStore.getState().setMergeMode('hybrid');
          } catch {}
          return;
        }
        case 'logmerge.saved': {
          disallowEstimates('logmerge.saved');
          const total =
            (typeof payload?.total === 'number' ? payload.total : undefined) ??
            (typeof payload?.merged === 'number' ? payload.merged : undefined);
          if (typeof total === 'number') {
            // 최종 수치로 진행률과 총행수를 확정
            useLogStore.getState().mergeProgress({ done: total, total, active: false });
            useLogStore.getState().setTotalRows(total);
          } else {
            // 총량 정보가 없으면 진행 상태만 종료
            useLogStore.getState().mergeProgress({ active: false });
          }
          MERGE_ACTIVE = false;
          // 완료 문구는 스티키하게 유지
          try {
            useLogStore.getState().setMergeStage('병합 완료');
          } catch {}

          return;
        }
        case 'search.results': {
          const hits = (payload?.hits ?? []).map((h: any) => ({
            idx: Number(h?.idx) || 0,
            text: String(h?.text || ''),
          }));
          // quiet
          // q 동기화(+ 닫힘 상태 레이스 방지 로직은 store 쪽에 존재)
          const q = typeof payload?.q === 'string' ? String(payload.q) : undefined;
          useLogStore.getState().setSearchResults(hits, { q });
          return;
        }
        case 'error': {
          // quiet
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
  const file = typeof e?.file === 'string' && e.file ? e.file : '';
  const p = typeof e?.path === 'string' && e.path ? e.path : '';
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
  // quiet
  const next = measureUi('ipc.normalizeFilter', () => normalizeFilter(filter));
  if (!READY_FOR_FILTER) {
    PENDING_FILTER = next;
    // quiet
    // quiet
    return;
  }
  measureUi('ipc.flushFilter', () => flushFilter(next));
  // quiet
}

function normalizeFilter(f: any) {
  // quiet
  const s = (v: any) => String(v ?? '').trim();
  const pid = s(f?.pid);
  const src = s(f?.src);
  const proc = s(f?.proc);
  const msg = s(f?.msg);
  // quiet
  return { pid, src, proc, msg };
}

function isEmptyFilter(f: { pid?: string; src?: string; proc?: string; msg?: string }) {
  const s = (v: any) => String(v ?? '').trim();
  return !s(f.pid) && !s(f.src) && !s(f.proc) && !s(f.msg);
}

function flushFilter(next: { pid: string; src: string; proc: string; msg: string }) {
  // quiet
  // 모든 필드가 빈 문자열이면 '해제'로 간주하여 null 전송
  const payload = isEmptyFilter(next) ? { filter: null } : { filter: next };
  // quiet
  vscode?.postMessage({ v: 1, type: 'logs.filter.set', payload });
  // quiet
}

// ────────────── PROBE: 수신 배치 내용 요약 ──────────────
function probeRows(
  tag: 'batch' | 'page',
  rows: Array<{ idx?: number; time?: string; src?: string }>,
) {
  const fmt = (r: any) => `${r.idx ?? '?'}|${r.time ?? '-'}|${r.src ?? ''}`;
  const head = rows.slice(0, 5).map(fmt).join(' || ');
  const tail = rows.slice(-5).map(fmt).join(' || ');
  const mono = isMonoAsc(rows.map((r) => (typeof r.idx === 'number' ? r.idx : Infinity)));
  // quiet
  // quiet
  // quiet
}
function isMonoAsc(a: number[]) {
  for (let i = 1; i < a.length; i++) if (a[i - 1] > a[i]) return false;
  return true;
}
