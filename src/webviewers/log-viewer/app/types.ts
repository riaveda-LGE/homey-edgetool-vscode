export type ColumnId = 'time' | 'proc' | 'pid' | 'src' | 'msg';

export interface LogRow {
  id: number;          // 증가 ID (버퍼 내 unique)
  time: string;
  proc: string;
  pid: string;
  src?: string;        // 원본 파일명 (예: kernel.log)
  msg: string;
  bookmarked?: boolean;
}

export interface HighlightRule {
  text: string;
  color?: 'c1'|'c2'|'c3'|'c4'|'c5'|'c6'|'c7'|'c8'|'c9'|'c10'|'c11'|'c12';
}

export interface Model {
  rows: LogRow[];
  nextId: number;
  bufferSize: number;

  // 가상 스크롤 메타
  totalRows: number;     // 전체 병합 결과 행수
  windowSize: number;    // 현재 유지할 행수 (기본 500)
  windowStart: number;   // 전역 인덱스 시작(최신=1 기준)
  rowH: number;          // 행 높이(px)
  overscan: number;      // 오버스캔 행수

  // UI state
  showCols: Record<ColumnId, boolean>;
  highlights: HighlightRule[];
  showHighlightEditor: boolean;

  // 검색
  searchQuery: string;
  searchOpen: boolean;
  searchHits: { rowId: number; col: ColumnId; excerpt: string }[];

  // 북마크
  showBookmarks: boolean;

  // 선택/포커스
  selectedRowId?: number;

  // 컬럼 너비 (px)
  colW: { time: number; proc: number; pid: number; src: number };

  // 박스 선택
  selecting: boolean;
  selRect?: DOMRect;

  // 모달
  modalMsg?: string;

  // ⬇ 병합 진행률
  mergeActive: boolean;
  mergeDone: number;
  mergeTotal: number;
}

export type Msg =
  | { type: 'AppendLog'; line: string; src?: string }
  | { type: 'AppendLogsBatch'; lines: string[] }   // (현재 미사용)
  | { type: 'ToggleColumn'; col: ColumnId; on: boolean }
  | { type: 'OpenHighlight' }
  | { type: 'CloseHighlight' }
  | { type: 'SetHighlights'; rules: HighlightRule[] }
  | { type: 'Search'; q: string }
  | { type: 'SearchClose' }
  | { type: 'OpenMsgModal'; text: string }
  | { type: 'CloseMsgModal' }
  | { type: 'ToggleBookmark'; rowId: number }
  | { type: 'ToggleBookmarksPane' }
  | { type: 'JumpToRow'; rowId: number }
  | { type: 'ResizeColumn'; col: 'time'|'proc'|'pid'|'src'; dx: number; commit: boolean }
  | { type: 'StartBoxSelect'; rect: DOMRect }
  | { type: 'UpdateBoxSelect'; rect: DOMRect }
  | { type: 'EndBoxSelect' }
  | { type: 'MergeProgress'; inc?: number; total?: number; reset?: boolean; active?: boolean }
  // 가상 스크롤 전용
  | { type: 'SetTotalRows'; total: number }
  | { type: 'ReceiveRows'; startIdx: number; rows: LogRow[] }
  ;
