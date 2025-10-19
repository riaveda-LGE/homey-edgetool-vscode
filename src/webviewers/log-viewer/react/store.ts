import { create } from 'zustand';

import { LOG_OVERSCAN, LOG_ROW_HEIGHT, LOG_WINDOW_SIZE } from '../../../shared/const';
import { postFilterUpdate } from './ipc';
import type { ColumnId, Filter, HighlightRule, LogRow, Model } from './types';

const initial: Model = {
  rows: [],
  nextId: 1,
  bufferSize: 2000,
  totalRows: 0,
  windowSize: LOG_WINDOW_SIZE,
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
  setFilterField(f: keyof Filter, v: string): void;
  applyFilter(next: Filter): void; // ← 디바운스 후 한 번만 전송
  resetFilters(): void;
};

export const useLogStore = create<Model & Actions>()((set, get) => ({
  ...initial,
  setTotalRows(total) {
    set({ totalRows: Math.max(0, total | 0) });
  },

  receiveRows(startIdx, rows) {
    const state = get();
    const maxId = Math.max(state.nextId, (rows.at(-1)?.id ?? 0) + 1);
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
  },

  toggleColumn(col, on) {
    set({ showCols: { ...get().showCols, [col]: on } });
  },

  setHighlights(rules) {
    const norm = rules
      .filter((r) => r.text.trim())
      .slice(0, 5)
      .map((r) => ({ text: r.text.trim(), color: r.color ?? ('c1' as const) }));
    set({ highlights: norm });
  },

  setSearch(q) {
    // 쿼리만 저장. 패널 오픈은 명시적으로 openSearchPanel에서 처리.
    const t = q.trim();
    if (!t) return set({ searchQuery: '', searchHits: [], searchOpen: false });
    set({ searchQuery: t });
  },
  closeSearch() {
    set({ searchOpen: false, searchQuery: '', searchHits: [] });
  },
  openSearchPanel() {
    set({ searchOpen: true });
  },
  setSearchResults(hits, opts) {
    const st = get();
    // 사용자가 닫은 뒤(쿼리도 비움) 늦게 도착한 결과는 무시하여 재오픈 방지
    if (!st.searchOpen && !st.searchQuery.trim()) return;
    const nextQ = (opts?.q ?? st.searchQuery) || '';
    set({ searchOpen: true, searchHits: hits, searchQuery: nextQ });
  },

  toggleBookmark(rowId) {
    // 북마크 패널 자동 열림 방지: 단순히 행의 상태만 토글
    const rows = get().rows.map((r) => (r.id === rowId ? { ...r, bookmarked: !r.bookmarked } : r));
    set({ rows });
  },

  toggleBookmarksPane() {
    set({ showBookmarks: !get().showBookmarks });
  },
  setBookmarksPane(open) {
    set({ showBookmarks: !!open });
  },
  jumpToRow(rowId, idx) {
    // 직접 클릭/북마크/검색결과에서 선택: 즉시 선택 표시
    set({ selectedRowId: rowId });
    // 참고: 실제 스크롤 이동은 jumpToIdx가 담당
    // (여기서는 선택만 처리; idx는 디버깅/확장용으로 보존)
  },
  jumpToIdx(idx) {
    set({ pendingJumpIdx: Math.max(1, idx | 0) });
  },

  resizeColumn(col, dx) {
    const next = { ...get().colW };
    const base = Math.max(60, ((next as any)[col] || 120) + dx);
    (next as any)[col] = base;
    set({ colW: next });
  },

  mergeProgress({ inc, total, reset, active, done }) {
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
  },

  // ── 필터 상태 ─────────────────────────────────────────────────────────
  setFilterField(f, v) {
    const next = { ...get().filter, [f]: v };
    set({ filter: next }); // ← 여기서는 전송하지 않음
  },
  applyFilter(next) {
    set({ filter: next });
    postFilterUpdate(next); // ← 실제 전송은 여기서만
  },
  resetFilters() {
    const empty = { pid: '', src: '', proc: '', msg: '' };
    set({ filter: empty });
    postFilterUpdate(empty); // 초기화는 즉시 반영
  },
}));

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// (클라이언트 검색은 제거되었습니다 — 서버 검색 사용)
