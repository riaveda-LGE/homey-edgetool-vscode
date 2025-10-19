export type ColumnId = 'time' | 'proc' | 'pid' | 'src' | 'msg';
export type HighlightColor =
  | 'c1'|'c2'|'c3'|'c4'|'c5'|'c6'|'c7'|'c8'|'c9'|'c10'|'c11'|'c12';

export interface HighlightRule { text: string; color?: HighlightColor; }

export interface LogRow {
  id: number;
  time: string;
  proc: string;
  pid: string;
  msg: string;
  src?: string;
  /** 원본 한 줄 전체 문자열(팝업, 복사용) */
  raw: string;
  bookmarked?: boolean;
}

export type Filter = { pid: string; src: string; proc: string; msg: string };

export interface Model {
  rows: LogRow[];
  nextId: number;
  bufferSize: number;

  totalRows: number;
  windowSize: number;
  windowStart: number;
  rowH: number;
  overscan: number;

  showCols: Record<ColumnId, boolean>;
  colW: { time: number; proc: number; pid: number; src: number };

  highlights: HighlightRule[];
  searchQuery: string;
  searchOpen: boolean;
  searchHits: { rowId: number; col: ColumnId; excerpt: string }[];
  showBookmarks: boolean;
  selectedRowId?: number;

  mergeActive: boolean;
  mergeDone: number;
  mergeTotal: number;

  filter: Filter;
}
