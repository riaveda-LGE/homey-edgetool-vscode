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
  toggleBookmark(rowId: number): void;
  toggleBookmarksPane(): void;
  jumpToRow(rowId: number): void;
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
    if (!q.trim()) return set({ searchQuery:'', searchOpen:false, searchHits:[] });
    const regex = new RegExp(escapeRegExp(q), 'i');
    const hits = get().rows.flatMap((r) => {
      const cols: ColumnId[] = ['time','proc','pid','src','msg'];
      const out: {rowId:number; col:ColumnId; excerpt:string}[] = [];
      for (const c of cols){
        const text = String((r as any)[c] ?? '');
        if (regex.test(text)){
          const ex = buildExcerpt(text, q);
          out.push({ rowId: r.id, col: c, excerpt: ex });
        }
      }
      return out;
    });
    set({ searchQuery:q, searchOpen:true, searchHits:hits });
  },
  closeSearch(){ set({ searchOpen:false, searchQuery:'', searchHits:[] }); },

  toggleBookmark(rowId){
    const rows = get().rows.map(r=> r.id===rowId ? {...r, bookmarked: !r.bookmarked } : r);
    const any = rows.some(r=>r.bookmarked);
    set({ rows, showBookmarks: any || get().showBookmarks });
  },

  toggleBookmarksPane(){ set({ showBookmarks: !get().showBookmarks }); },
  jumpToRow(rowId){ set({ selectedRowId: rowId }); },

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
function buildExcerpt(text:string, q:string){
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx<0) return text.slice(0,120);
  const start = Math.max(0, idx-30), end = Math.min(text.length, idx+q.length+30);
  return text.slice(start, end).replace(new RegExp(escapeRegExp(q),'ig'), m=>`<<${m}>>`);
}
