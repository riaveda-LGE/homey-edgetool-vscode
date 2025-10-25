export type ColumnId = 'time' | 'proc' | 'pid' | 'src' | 'msg';
export type HighlightColor =
  | 'c1'
  | 'c2'
  | 'c3'
  | 'c4'
  | 'c5'
  | 'c6'
  | 'c7'
  | 'c8'
  | 'c9'
  | 'c10'
  | 'c11'
  | 'c12';

export interface HighlightRule {
  text: string;
  color?: HighlightColor;
}

export interface LogRow {
  id: number;
  /** 전역 인덱스(오름차순: 과거=1, 최신=total). 페이징/점프에 사용 */
  idx?: number;
  time: string;
  proc: string;
  pid: string;
  msg: string;
  src?: string;
  /** 원본 한 줄 전체 문자열(팝업, 복사용) */
  raw: string;
  bookmarked?: boolean;
}

export interface BookmarkItem {
  idx: number;
  time: string;
  msg: string;
  src?: string;
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
  searchHits: { idx: number; text: string }[];
  showBookmarks: boolean;
  selectedRowId?: number;

  mergeActive: boolean;
  mergeDone: number;
  mergeTotal: number;

  filter: Filter;
  pendingJumpIdx?: number;
  follow: boolean;
  newSincePause: number;
  /** 북마크: 전역 인덱스(idx) 기반의 영속 맵(세션 단위) */
  bookmarks: Record<number, BookmarkItem>;
}
