// src/webviewers/log-viewer/views/AppView.ts
import type { Model, Msg } from '../app/types';
import { renderBookmarks } from './BookmarksView';
import { el } from './dom';
import { renderHeader } from './GridHeaderView';
import { renderGrid } from './GridView';
import { bindHorizontalSplitter,bindVerticalSplitter } from './Layout/splitter';
import { renderSearch } from './SearchView';
import { renderToolbar } from './ToolbarView';

export function mountSplitters(_dispatch: (msg: Msg)=>void){
  // ✅ 상단 splitter(툴바 <-> 로그뷰)는 드래그 비활성 & 시각적으로 숨김
  //    - 레이아웃 트랙은 유지 (grid 계산 안정)
  //    - 기본 툴바 높이를 강제로 초기화
  const root = document.documentElement;
  root.style.setProperty('--toolbar-h', '44px'); // 기본 높이 고정

  if (el.topSplitter) {
    el.topSplitter.style.height = '0px';
    el.topSplitter.style.minHeight = '0';
    el.topSplitter.style.border = 'none';
    el.topSplitter.style.pointerEvents = 'none';
    // 필요 시 테마 배경 잔선 제거
    el.topSplitter.style.background = 'transparent';
  }
  // 상단 스플리터는 바인딩하지 않음

  // 하단 splitter: main <-> searchResults
  bindVerticalSplitter({
    el: el.bottomSplitter,
    onDelta: (dy) => {
      const cur = el.searchResults.offsetHeight || 120;
      const next = clamp(cur - dy, 90, Math.floor(window.innerHeight * .6));
      el.searchResults.style.height = `${next}px`;
    }
  });

  // 북마크 수평 splitter: center | splitter | bookmarks
  bindHorizontalSplitter({
    el: el.midSplitter,
    onDelta: (dx) => {
      const cur = cssPx(root, '--bookmark-w', el.bookmarkPane.offsetWidth || 260);
      const next = clamp(cur - dx, 200, 600);
      root.style.setProperty('--bookmark-w', `${next}px`);
    }
  });
}

export function render(model: Model, dispatch: (m: Msg)=>void){
  renderToolbar(model, dispatch);
  renderHeader(model, dispatch);
  renderGrid(model, dispatch);
  renderBookmarks(model, dispatch);
  renderSearch(model, dispatch);
}

/* utils */
function cssPx(el: Element, varName: string, fallback = 0){
  const n = Number(getComputedStyle(el).getPropertyValue(varName).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}
function clamp(n:number,min:number,max:number){ return Math.min(max, Math.max(min, n)); }
