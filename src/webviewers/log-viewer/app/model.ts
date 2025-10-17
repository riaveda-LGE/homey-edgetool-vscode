import { LOG_OVERSCAN,LOG_ROW_HEIGHT, LOG_WINDOW_SIZE } from '../../../shared/const';
import type { Model } from './types';

export const initModel = (): Model => ({
  rows: [],
  nextId: 1,
  bufferSize: 2000,

  // 가상 스크롤 기본값
  totalRows: 0,
  windowSize: LOG_WINDOW_SIZE,
  windowStart: 1,           // 최신 = 1
  rowH: LOG_ROW_HEIGHT,
  overscan: LOG_OVERSCAN,

  // 파일(src) 컬럼 추가
  showCols: { time: true, proc: true, pid: true, src: true, msg: true },
  highlights: [],
  showHighlightEditor: false,

  searchQuery: '',
  searchOpen: false,
  searchHits: [],

  showBookmarks: false,
  selectedRowId: undefined,

  // 파일(src) 너비 추가
  colW: { time: 160, proc: 160, pid: 80, src: 180 },

  selecting: false,
  selRect: undefined,

  modalMsg: undefined,

  // 병합 진행률 초기값
  mergeActive: false,
  mergeDone: 0,
  mergeTotal: 0,
});
