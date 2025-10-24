import { create } from 'zustand';

import { LOG_OVERSCAN, LOG_ROW_HEIGHT, LOG_WINDOW_SIZE } from '../../../shared/const';
import { createUiMeasure } from '../../shared/utils';
import { vscode } from './ipc';
import { createUiLog } from '../../shared/utils';
import { postFilterUpdate } from './ipc';
import type { ColumnId, Filter, HighlightRule, LogRow, Model } from './types';

const initial: Model = {
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
  filter: { pid: '', src: '', proc: '', msg: '' },
  follow: true,
  newSincePause: 0,
};

type Actions = {
  setTotalRows(total: number): void;
  receiveRows(startIdx: number, rows: LogRow[]): void;
  toggleColumn(col: ColumnId, on: boolean): void;
  setHighlights(rules: HighlightRule[]): void;
  setSearch(q: string): void;
  closeSearch(): void;
  openSearchPanel(): void;
  setSearchResults(hits: { idx: number; text: string }[], opts?: { q?: string }): void;
  toggleBookmark(rowId: number): void;
  toggleBookmarksPane(): void;
  setBookmarksPane(open: boolean): void;
  jumpToRow(rowId: number, idx?: number): void;
  jumpToIdx(idx: number): void;
  resizeColumn(col: 'time' | 'proc' | 'pid' | 'src', dx: number): void;
  mergeProgress(args: {
    inc?: number; total?: number; reset?: boolean; active?: boolean; done?: number
  }): void;
  measureUi: ReturnType<typeof createUiMeasure>;
  setFilterField(f: keyof Filter, v: string): void;
  applyFilter(next: Filter): void; // ← 디바운스 후 한 번만 전송
  resetFilters(): void;
  setFollow(follow: boolean): void;
  incNewSincePause(): void;
  clearNewSincePause(): void;
};

export const useLogStore = create<Model & Actions>()((set, get) => ({
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
      // ── PROBE: 수신 버퍼 정합성
      const first = rows[0]?.idx;
      const last  = rows.length ? rows[rows.length - 1]?.idx : undefined;
      const asc   = rows.every((r, i, arr) =>
        i === 0 || ((arr[i - 1]?.idx ?? -Infinity) <= (r?.idx ?? Infinity)));
      (get() as any).__ui?.info?.(
        `[probe:store] receive start=${startIdx} len=${rows.length} idxAsc=${asc} first=${first} last=${last} nextId(before)=${state.nextId}`,
      );
      // 점프 대상이 이번에 수신된 버퍼 안에 있으면 즉시 선택 행을 갱신
      let selectedRowId = state.selectedRowId;
      if (state.pendingJumpIdx) {
        const hit = rows.find((r) => typeof r.idx === 'number' && r.idx === state.pendingJumpIdx);
        if (hit) selectedRowId = hit.id;
      }
      set({
        rows,
        nextId: maxId,
        windowStart: Math.max(1, startIdx | 0),
        selectedRowId,
      });
      // 과도한 로그 방지: 범위 바뀔 때만 간단 요약
      const end = startIdx + rows.length - 1;
      (get() as any).__ui?.debug?.(`store.receiveRows ${startIdx}-${end} (${rows.length})`);
      // ── PROBE: 머지 후 창 범위/샘플
      const s2 = get();
      const winStart = s2.windowStart ?? 1;
      const winEnd   = Math.min((s2.windowStart ?? 1) + (s2.windowSize ?? 0) - 1, s2.totalRows ?? 0);
      const sample   = (s2.rows ?? []).slice(0, Math.min(10, s2.rows.length));
      const sampleStr = sample.map((r: any) => `${r.idx ?? '?'}|${r.time ?? '-'}`).join(', ');
      (get() as any).__ui?.info?.(
        `[probe:store] window=${winStart}-${winEnd} sample(top10)=${sampleStr} nextId(after)=${s2.nextId}`,
      );
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
      // 북마크 패널 자동 열림 방지: 단순히 행의 상태만 토글
      const rows = get().rows.map((r) => (r.id === rowId ? { ...r, bookmarked: !r.bookmarked } : r));
      set({ rows });
      (get() as any).__ui?.debug?.('store.toggleBookmark');
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
      set({ pendingJumpIdx: Math.max(1, idx | 0) });
      (get() as any).__ui?.debug?.(`store.jumpToIdx idx=${idx}`);
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
      const doneVal = typeof done === 'number'
        ? Math.max(0, done)
        : Math.max(0, base + (inc ?? 0));
      let act = active ?? cur.mergeActive;
      if (t > 0 && doneVal >= t) act = false;
      set({ mergeTotal: t, mergeDone: doneVal, mergeActive: act });
      // 10% 단위 또는 완료 시에만 기록
      const pct = t > 0 ? Math.floor((doneVal / t) * 100) : 0;
      const key = '__lastMergePct';
      const last = (get() as any)[key] ?? -1;
      if (!act || pct >= 100 || pct >= last + 10) {
        (get() as any).__ui?.info?.(`merge.progress ${pct}% (${doneVal}/${t}) active=${act}`);
        (get() as any)[key] = pct;
      }
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
}));

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// (클라이언트 검색은 제거되었습니다 — 서버 검색 사용)
