import { create } from 'zustand';

import { LOG_OVERSCAN, LOG_ROW_HEIGHT, LOG_WINDOW_SIZE } from '../../../shared/const';
// merge.stage 표시 텍스트 계산 유틸은 이 파일 내부에서 유지
import { createUiMeasure } from '../../shared/utils';
import { createUiLog } from '../../shared/utils';
import { vscode } from './ipc';
import { postFilterUpdate } from './ipc';
import type { BookmarkItem, ColumnId, Filter, HighlightRule, LogRow, Model } from './types';

// mergeMode/mergeStage는 Model에 없을 수 있으므로 교차 타입으로 선언
const initial: Model & { mergeMode?: 'memory' | 'hybrid'; mergeStage?: string } = {
  rows: [],
  nextId: 1,
  bufferSize: 2000,
  totalRows: 0,
  // overscan 확장 요청에도 충분히 커버되도록 최소 버퍼 보장
  // (LOG_WINDOW_SIZE 가 작게 설정된 환경 대비)
  windowSize: Math.max(LOG_WINDOW_SIZE, LOG_OVERSCAN * 2 + 128),
  windowStart: 1,
  rowH: LOG_ROW_HEIGHT,
  overscan: LOG_OVERSCAN,
  showCols: { time: true, proc: true, pid: true, src: true, msg: true },
  colW: { time: 160, proc: 160, pid: 80, src: 180 },
  highlights: [],
  searchQuery: '',
  searchOpen: false,
  searchHits: [],
  showBookmarks: false,
  selectedRowId: undefined,
  pendingJumpIdx: undefined,
  mergeActive: false,
  mergeDone: 0,
  mergeTotal: 0,
  // NOTE: 타입 상 Model에 없을 수 있어 런타임 전용으로 취급(액션으로만 갱신)
  filter: { pid: '', src: '', proc: '', msg: '' },
  follow: true,
  newSincePause: 0,
  bookmarks: {},
  mergeMode: 'memory',
};

// ────────────────────────────────────────────────────────────────────────────
// merge.stage 표시용 텍스트를 (진행률 숫자 포함해) 계산
function stripCounterSuffix(s: string) {
  // 뒤쪽의 " (123/456)" 패턴을 제거
  return String(s || '')
    .replace(/\s*\(\d+\/\d+\)\s*$/, '')
    .trim();
}
function computeStageText(base: string, done?: number, total?: number) {
  const b = stripCounterSuffix(base);
  if (!b) return '';
  return b;
}
// ────────────────────────────────────────────────────────────────────────────

type Actions = {
  setTotalRows(total: number): void;
  receiveRows(startIdx: number, rows: LogRow[]): void;
  toggleColumn(col: ColumnId, on: boolean): void;
  setHighlights(rules: HighlightRule[]): void;
  setSearch(q: string): void;
  closeSearch(): void;
  openSearchPanel(): void;
  setSearchResults(hits: { idx: number; text: string }[], opts?: { q?: string }): void;
  toggleBookmark: (rowId: number) => void;
  toggleBookmarkByIdx: (globalIdx: number) => void;
  toggleBookmarksPane(): void;
  setBookmarksPane(open: boolean): void;
  jumpToRow(rowId: number, idx?: number): void;
  jumpToIdx(idx: number): void;
  resizeColumn(col: 'time' | 'proc' | 'pid' | 'src', dx: number): void;
  mergeProgress(args: {
    inc?: number;
    total?: number;
    reset?: boolean;
    active?: boolean;
    done?: number;
  }): void;
  setMergeStage(text: string): void;
  setMergeMode(mode: 'memory' | 'hybrid'): void;
  measureUi: ReturnType<typeof createUiMeasure>;
  setFilterField(f: keyof Filter, v: string): void;
  applyFilter(next: Filter): void; // ← 디바운스 후 한 번만 전송
  resetFilters(): void;
  setFollow(follow: boolean): void;
  incNewSincePause(): void;
  clearNewSincePause(): void;
  // ── 메모리 표시용 액션 ────────────────────────────────────────────────
  setHostMemMB(mb?: number): void;
  setWebMemMB(mb?: number): void;
};

type ExtraState = { hostMemMB?: number; webMemMB?: number };

export const useLogStore = create<Model & ExtraState & Actions>()((set, get) => ({
  ...initial,
  // 로거: 스토어 변경 시점 추적
  __ui: createUiLog(vscode, 'log-viewer.store'),
  measureUi: createUiMeasure(vscode),
  setTotalRows(total) {
    get().measureUi('store.setTotalRows', () => {
      const prev = get().totalRows;
      const next = Math.max(0, total | 0);
      set({ totalRows: next });
      // 총행수 변화가 실제로 있을 때만 1회 기록
      if (prev !== next) (get() as any).__ui?.info?.(`store.totalRows ${prev}→${next}`);
    });
  },

  receiveRows(startIdx, rows) {
    get().measureUi('store.receiveRows', () => {
      const state = get();
      const maxIdInBatch = rows.reduce((m, r) => Math.max(m, r.id ?? 0), 0);
      const maxId = Math.max(state.nextId, maxIdInBatch + 1);
      // 북마크 맵을 반영하여 플래그 복원
      const bm = state.bookmarks || {};
      const rowsWithBm = rows.map((r) => {
        const k = typeof r.idx === 'number' ? r.idx : undefined;
        return k && bm[k] ? { ...r, bookmarked: true } : r;
      });
      // ── PROBE: 수신 버퍼 정합성
      const first = rowsWithBm[0]?.idx;
      const last = rowsWithBm.length ? rowsWithBm[rowsWithBm.length - 1]?.idx : undefined;
      const asc = rowsWithBm.every(
        (r, i, arr) => i === 0 || (arr[i - 1]?.idx ?? -Infinity) <= (r?.idx ?? Infinity),
      );
      // 점프 대상이 이번에 수신된 버퍼 안에 있으면 즉시 선택 행을 갱신
      let selectedRowId = state.selectedRowId;
      if (state.pendingJumpIdx) {
        const hit = rowsWithBm.find(
          (r) => typeof r.idx === 'number' && r.idx === state.pendingJumpIdx,
        );
        if (hit) selectedRowId = hit.id;
      }
      // ─────────────────────────────────────────────────────────────
      // A) 합집합(Union) 병합 + 하단 고정(head-only eviction)
      //    - 응답 순서 뒤섞여도 tail(coverageEnd) 회귀 금지
      const curRows = Array.isArray(state.rows) ? state.rows : [];
      const hasCur = curRows.length > 0;
      const curStart = Math.max(1, (state.windowStart as number) | 0);
      const curEnd = hasCur ? curStart + curRows.length - 1 : 0;

      const incStart = Math.max(1, startIdx | 0);
      const incLen = rowsWithBm.length;
      const incEnd = incLen ? incStart + incLen - 1 : incStart - 1;

      // 새 커버리지 경계(단조 증가: 하단 회귀 금지)
      let newStart = hasCur ? Math.min(curStart, incStart) : incStart;
      let newEnd = hasCur ? Math.max(curEnd, incEnd) : incEnd;
      if (newEnd < newStart) {
        newStart = incStart;
        newEnd = incEnd;
      }

      // 병합 버퍼 구성(연속 페이지 가정)
      const total = Math.max(0, newEnd - newStart + 1);
      let merged: LogRow[] = total ? new Array(total) as unknown as LogRow[] : [];
      // 기존 복사
      if (hasCur) {
        const off = curStart - newStart;
        for (let i = 0; i < curRows.length; i++) merged[off + i] = curRows[i];
      }
      // 신규 복사(중복 구간은 신규로 갱신)
      {
        const off = incStart - newStart;
        for (let i = 0; i < incLen; i++) merged[off + i] = rowsWithBm[i];
      }

      // cap: windowSize 기준(뷰 윈도우와 동일 크기 유지). 초과 시 상단만 축출하여 tail 보존
      const cap = Math.max(1, (state.windowSize as number) | 0);
      if (merged.length > cap) {
        const cut = merged.length - cap;   // 앞에서 자를 양
        merged = merged.slice(cut);        // head-only eviction
        newStart = newStart + cut;
      }

      set({
        rows: merged,
        nextId: maxId,
        windowStart: Math.max(1, newStart | 0),
        selectedRowId,
      });
      // 과도한 로그 방지: 범위 바뀔 때만 간단 요약
      const end = startIdx + rows.length - 1;
      (get() as any).__ui?.debug?.(`store.receiveRows ${startIdx}-${end} (${rows.length})`);
      // ── PROBE: 머지 후 창 범위/샘플
      const s2 = get();
      const winStart = s2.windowStart ?? 1;
      const winEnd = Math.min((s2.windowStart ?? 1) + (s2.windowSize ?? 0) - 1, s2.totalRows ?? 0);
      const sample = (s2.rows ?? []).slice(0, Math.min(10, s2.rows.length));
      const sampleStr = sample.map((r: any) => `${r.idx ?? '?'}|${r.time ?? '-'}`).join(', ');
    });
  },

  toggleColumn(col, on) {
    get().measureUi('store.toggleColumn', () => {
      set({ showCols: { ...get().showCols, [col]: on } });
      (get() as any).__ui?.debug?.(`store.toggleColumn ${col}=${on}`);
    });
  },

  setHighlights(rules) {
    get().measureUi('store.setHighlights', () => {
      const norm = rules
        .filter((r) => r.text.trim())
        .slice(0, 5)
        .map((r) => ({ text: r.text.trim(), color: r.color ?? ('c1' as const) }));
      set({ highlights: norm });
      (get() as any).__ui?.debug?.(`store.setHighlights n=${norm.length}`);
    });
  },

  setSearch(q) {
    get().measureUi('store.setSearch', () => {
      // 쿼리만 저장. 패널 오픈은 명시적으로 openSearchPanel에서 처리.
      const t = q.trim();
      if (!t) return set({ searchQuery: '', searchHits: [], searchOpen: false });
      set({ searchQuery: t });
      (get() as any).__ui?.debug?.('store.setSearch');
    });
  },
  closeSearch() {
    get().measureUi('store.closeSearch', () => {
      set({ searchOpen: false, searchQuery: '', searchHits: [] });
      (get() as any).__ui?.debug?.('store.closeSearch');
    });
  },
  openSearchPanel() {
    get().measureUi('store.openSearchPanel', () => {
      set({ searchOpen: true });
      (get() as any).__ui?.debug?.('store.openSearchPanel');
    });
  },
  setSearchResults(hits, opts) {
    get().measureUi('store.setSearchResults', () => {
      const st = get();
      // 사용자가 닫은 뒤(쿼리도 비움) 늦게 도착한 결과는 무시하여 재오픈 방지
      if (!st.searchOpen && !st.searchQuery.trim()) return;
      const nextQ = (opts?.q ?? st.searchQuery) || '';
      set({ searchOpen: true, searchHits: hits, searchQuery: nextQ });
      (get() as any).__ui?.info?.(`search.results hits=${hits.length}`);
    });
  },

  toggleBookmark(rowId) {
    get().measureUi('store.toggleBookmark', () => {
      const st = get();
      const row = st.rows.find((r) => r.id === rowId);
      const idx = row?.idx;
      if (typeof idx !== 'number' || idx <= 0) {
        (get() as any).__ui?.warn?.(`store.toggleBookmark ignored: invalid idx for rowId=${rowId}`);
        return;
      }
      // 모든 토글은 단일 경로로
      st.toggleBookmarkByIdx(idx);
    });
  },

  toggleBookmarkByIdx(globalIdx) {
    get().measureUi('store.toggleBookmarkByIdx', () => {
      const st = get();
      const bookmarks = { ...st.bookmarks };
      if (bookmarks[globalIdx]) {
        // 북마크 제거
        delete bookmarks[globalIdx];
      } else {
        // 북마크 추가: 현재 로드된 행에서 정보를 가져옴
        const row = st.rows.find((r) => r.idx === globalIdx);
        if (row) {
          bookmarks[globalIdx] = {
            idx: globalIdx,
            time: row.time,
            msg: row.msg,
            src: row.src,
          };
        }
      }
      // 현재 로드된 행의 bookmarked 필드 업데이트
      const rows = st.rows.map((r) =>
        r.idx === globalIdx ? { ...r, bookmarked: !!bookmarks[globalIdx] } : r,
      );
      set({ bookmarks, rows });
      (get() as any).__ui?.debug?.(
        `store.toggleBookmarkByIdx idx=${globalIdx} added=${!!bookmarks[globalIdx]}`,
      );
    });
  },

  toggleBookmarksPane() {
    get().measureUi('store.toggleBookmarksPane', () => {
      set({ showBookmarks: !get().showBookmarks });
      (get() as any).__ui?.debug?.('store.toggleBookmarksPane');
    });
  },
  setBookmarksPane(open) {
    get().measureUi('store.setBookmarksPane', () => {
      set({ showBookmarks: !!open });
      (get() as any).__ui?.debug?.(`store.setBookmarksPane ${!!open}`);
    });
  },
  jumpToRow(rowId, idx) {
    get().measureUi('store.jumpToRow', () => {
      // 직접 클릭/북마크/검색결과에서 선택: 즉시 선택 표시
      set({ selectedRowId: rowId });
      // 참고: 실제 스크롤 이동은 jumpToIdx가 담당
      // (여기서는 선택만 처리; idx는 디버깅/확장용으로 보존)
      (get() as any).__ui?.debug?.(`store.jumpToRow id=${rowId} idx=${idx ?? '-'}`);
    });
  },
  jumpToIdx(idx) {
    get().measureUi('store.jumpToIdx', () => {
      // 검색/북마크 등 "명시적 점프" 시에는 tail 팔로우를 자동 해제한다.
      // (follow=true 상태에서 점프 직후 다시 tail로 되돌아가는 현상 방지)
      set({ pendingJumpIdx: Math.max(1, idx | 0), follow: false });
      (get() as any).__ui?.info?.(`store.jumpToIdx idx=${idx} (auto-pause follow)`);
    });
  },

  resizeColumn(col, dx) {
    get().measureUi('store.resizeColumn', () => {
      const next = { ...get().colW };
      const base = Math.max(60, ((next as any)[col] || 120) + dx);
      (next as any)[col] = base;
      set({ colW: next });
      (get() as any).__ui?.debug?.(`store.resizeColumn ${col} += ${dx}`);
    });
  },

  mergeProgress({ inc, total, reset, active, done }) {
    get().measureUi('store.mergeProgress', () => {
      const cur = get();
      const t = typeof total === 'number' ? Math.max(0, total) : cur.mergeTotal;
      // 우선순위: 명시 done → (reset?0:base)+inc
      const base = reset ? 0 : cur.mergeDone;
      const doneVal = typeof done === 'number' ? Math.max(0, done) : Math.max(0, base + (inc ?? 0));
      let act = active ?? cur.mergeActive;
      if (t > 0 && doneVal >= t) act = false; // 총량이 있을 때 완료 판정
      set({ mergeTotal: t, mergeDone: doneVal, mergeActive: act });
      // 10% 단위 또는 완료 시에만 기록
      const pct = t > 0 ? Math.floor((doneVal / t) * 100) : 0;
      const key = '__lastMergePct';
      const last = (get() as any)[key] ?? -1;
      if (!act || pct >= 100 || pct >= last + 10) {
        (get() as any).__ui?.info?.(`merge.progress ${pct}% (${doneVal}/${t}) active=${act}`);
        (get() as any)[key] = pct;
      }
      // 완료 시 단계 텍스트 정리(UX: 100% 막대 잔상 제거)
      if (!act) {
        // 완료 후에도 최신 알림을 유지: "병합 완료"
        set({ ...(get() as any), mergeStage: '병합 완료' } as any);
      } else {
        // 진행 중일 때 현재 stage 텍스트를 진행률과 동기화
        const curStage = (get() as any).mergeStage || '';
        const synced = computeStageText(curStage, doneVal, t);
        if (synced !== curStage) {
          set({ ...(get() as any), mergeStage: synced } as any);
        }
      }
    });
  },

  setMergeStage(text) {
    get().measureUi('store.setMergeStage', () => {
      const cur = get();
      // 진행률과 동기화된 텍스트 계산
      const synced = computeStageText(String(text || ''), cur.mergeDone, cur.mergeTotal);
      // Model 타입과의 충돌을 피하기 위해 any로 저장
      set({ ...(get() as any), mergeStage: synced } as any);
      (get() as any).__ui?.info?.(`merge.stage "${synced}"`);
    });
  },

  // ── 모드 토글(웹뷰에서만 사용) ─────────────────────────────────────────
  setMergeMode(mode) {
    get().measureUi('store.setMergeMode', () => {
      const next = (mode === 'hybrid' ? 'hybrid' : 'memory') as 'memory' | 'hybrid';
      set({ ...(get() as any), mergeMode: next } as any);
      (get() as any).__ui?.info?.(`store.setMergeMode ${next}`);
    });
  },

  // ── 필터 상태 ─────────────────────────────────────────────────────────
  setFilterField(f, v) {
    get().measureUi('store.setFilterField', () => {
      const next = { ...get().filter, [f]: v };
      set({ filter: next }); // ← 여기서는 전송하지 않음
      (get() as any).__ui?.debug?.(`store.setFilterField ${f}="${v}"`);
    });
  },
  applyFilter(next) {
    get().measureUi('store.applyFilter', () => {
      (get() as any).__ui?.debug?.('[debug] applyFilter: start');
      set({ filter: next });
      postFilterUpdate(next); // ← 실제 전송은 여기서만
      (get() as any).__ui?.info?.(`store.applyFilter ${JSON.stringify(next)}`);
      (get() as any).__ui?.debug?.('[debug] applyFilter: end');
    });
  },
  resetFilters() {
    get().measureUi('store.resetFilters', () => {
      (get() as any).__ui?.debug?.('[debug] resetFilters: start');
      const empty = { pid: '', src: '', proc: '', msg: '' };
      set({ filter: empty });
      postFilterUpdate(empty); // 초기화는 즉시 반영
      (get() as any).__ui?.info?.('store.resetFilters');
      (get() as any).__ui?.debug?.('[debug] resetFilters: end');
    });
  },
  setFollow(follow) {
    get().measureUi('store.setFollow', () => {
      set({ follow });
      (get() as any).__ui?.debug?.(`store.setFollow ${follow}`);
    });
  },
  incNewSincePause() {
    get().measureUi('store.incNewSincePause', () => {
      set({ newSincePause: get().newSincePause + 1 });
      (get() as any).__ui?.debug?.('store.incNewSincePause');
    });
  },
  clearNewSincePause() {
    get().measureUi('store.clearNewSincePause', () => {
      set({ newSincePause: 0 });
      (get() as any).__ui?.debug?.('store.clearNewSincePause');
    });
  },

  // ── 메모리 값 저장 (세션 스코프) ──────────────────────────────────────
  setHostMemMB(mb) {
    set({
      ...(get() as any),
      hostMemMB: typeof mb === 'number' ? Math.max(0, mb | 0) : undefined,
    } as any);
  },
  setWebMemMB(mb) {
    set({
      ...(get() as any),
      webMemMB: typeof mb === 'number' ? Math.max(0, mb | 0) : undefined,
    } as any);
  },
}));

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// (클라이언트 검색은 제거되었습니다 — 서버 검색 사용)
