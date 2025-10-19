import { create } from 'zustand';
import type { ColumnId, HighlightRule, LogRow, Model, Filter } from './types';
import { LOG_OVERSCAN, LOG_ROW_HEIGHT, LOG_WINDOW_SIZE } from '../../../shared/const';
import { postFilterUpdate } from './ipc';

const initial: Model = {
  rows: [], nextId: 1, bufferSize: 2000,
  totalRows: 0, windowSize: LOG_WINDOW_SIZE, windowStart: 1,
  rowH: LOG_ROW_HEIGHT, overscan: LOG_OVERSCAN,
  showCols: { time: true, proc: true, pid: true, src: true, msg: true },
  colW: { time: 160, proc: 160, pid: 80, src: 180 },
  highlights: [],
  searchQuery: '', searchOpen: false, searchHits: [],
  showBookmarks: false, selectedRowId: undefined,
  pendingJumpIdx: undefined,
  mergeActive: false, mergeDone: 0, mergeTotal: 0,
  filter: { pid:'', src:'', proc:'', msg:'' },
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
  jumpToRow(rowId: number, idx?: number): void;
  jumpToIdx(idx: number): void;
  resizeColumn(col: 'time'|'proc'|'pid'|'src', dx: number): void;
  mergeProgress(args: { inc?: number; total?: number; reset?: boolean; active?: boolean }): void;
  setFilterField(f: keyof Filter, v: string): void;
  applyFilter(next: Filter): void;   // ← 디바운스 후 한 번만 전송
  resetFilters(): void;
};

export const useLogStore = create<Model & Actions>()((set, get) => ({
  ...initial,
  setTotalRows(total){ set({ totalRows: Math.max(0, total|0) }); },

  receiveRows(startIdx, rows){
    const maxId = Math.max(get().nextId, ((rows.at(-1)?.id ?? 0) + 1));
    set({ rows, nextId: maxId, windowStart: Math.max(1, startIdx|0) });
  },

  toggleColumn(col,on){ set({ showCols: { ...get().showCols, [col]: on } }); },

  setHighlights(rules){
    const norm = rules.filter(r=>r.text.trim()).slice(0,5)
      .map(r=>({ text: r.text.trim(), color: r.color ?? 'c1' as const }));
    set({ highlights: norm });
  },

  setSearch(q){
    // 쿼리만 저장. 패널 오픈은 명시적으로 openSearchPanel에서 처리.
    const t = q.trim();
    if (!t) return set({ searchQuery:'', searchHits:[], searchOpen:false });
    set({ searchQuery:t });
  },
  closeSearch(){ set({ searchOpen:false, searchQuery:'', searchHits:[] }); },
  openSearchPanel(){ set({ searchOpen:true }); },
  setSearchResults(hits, opts){
    const st = get();
    // 사용자가 닫은 뒤(쿼리도 비움) 늦게 도착한 결과는 무시하여 재오픈 방지
    if (!st.searchOpen && !st.searchQuery.trim()) return;
    const nextQ = (opts?.q ?? st.searchQuery) || '';
    set({ searchOpen:true, searchHits:hits, searchQuery: nextQ });
  },

  toggleBookmark(rowId){
    const rows = get().rows.map(r=> r.id===rowId ? {...r, bookmarked: !r.bookmarked } : r);
    const any = rows.some(r=>r.bookmarked);
    set({ rows, showBookmarks: any || get().showBookmarks });
  },

  toggleBookmarksPane(){ set({ showBookmarks: !get().showBookmarks }); },
  jumpToRow(rowId, idx){
    // 직접 클릭/북마크에서 선택: 바로 선택 상태로 반영
    set({ selectedRowId: rowId });
    // idx가 함께 넘어오면 이후 페이지 교체에도 선택 유지가 자연스러움(추가 확장 대비)
    if (typeof idx === 'number' && idx > 0) {
      // 점프 요청 없이 선택만 갱신
      // (필요 시 여기서 pendingJumpIdx를 다룰 수 있으나 현재는 불필요)
    }
  },
  jumpToIdx(idx){ set({ pendingJumpIdx: Math.max(1, idx|0) }); },

  resizeColumn(col, dx){
    const next = { ...get().colW };
    const base = Math.max(60, ((next as any)[col] || 120) + dx);
    (next as any)[col] = base;
    set({ colW: next });
  },

  mergeProgress({inc, total, reset, active}){
    const cur = get();
    const t = typeof total === 'number' ? Math.max(0,total) : cur.mergeTotal;
    const base = reset ? 0 : cur.mergeDone;
    const done = Math.max(0, base + (inc ?? 0));
    let act = active ?? cur.mergeActive;
    if (t>0 && done>=t) act = false;
    set({ mergeTotal: t, mergeDone: done, mergeActive: act });
  },

  // ── 필터 상태 ─────────────────────────────────────────────────────────
  setFilterField(f, v){
    const next = { ...get().filter, [f]: v };
    set({ filter: next }); // ← 여기서는 전송하지 않음
  },
  applyFilter(next){
    set({ filter: next });
    postFilterUpdate(next); // ← 실제 전송은 여기서만
  },
  resetFilters(){
    const empty = { pid:'', src:'', proc:'', msg:'' };
    set({ filter: empty });
    postFilterUpdate(empty); // 초기화는 즉시 반영
  },
}));

function escapeRegExp(s:string){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
// (클라이언트 검색은 제거되었습니다 — 서버 검색 사용)
