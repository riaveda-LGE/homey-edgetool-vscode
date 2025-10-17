// src/webviewers/log-viewer/views/SearchView.ts
// 검색 결과 패널 렌더러 — raw 로그 전체를 표시하고, 검색어만 <mark>로 하이라이트
import type { Model, Msg } from '../app/types';
import { div,el } from './dom';

export function renderSearch(m: Model, dispatch: (msg: Msg) => void) {
  // 패널 닫힘
  if (!m.searchOpen) {
    el.searchResults.hidden = true;
    el.bottomSplitter.hidden = true;
    el.searchResults.style.height = '';
    el.searchResults.innerHTML = '';
    return;
  }

  // 패널 열림
  el.searchResults.hidden = false;
  el.bottomSplitter.hidden = false;

  // 내용 갱신
  el.searchResults.innerHTML = '';

  if (!m.searchHits.length) {
    const empty = div('sr-empty', []);
    empty.textContent = m.searchQuery ? '검색 결과 없음' : '검색어를 입력하세요';
    el.searchResults.append(empty);
    return;
  }

  const q = String(m.searchQuery ?? '');
  const re = q ? new RegExp(escapeRegExp(q), 'ig') : null;

  for (const hit of m.searchHits) {
    const row = m.rows.find((x) => x.id === hit.rowId);
    if (!row) continue;

    // ✅ raw 로그 한 줄 구성
    const raw = `[${row.time}] ${row.proc}[${row.pid}]:  ${row.msg}`;

    // 안전하게 이스케이프 후 검색어만 <mark>
    let html = escapeHtml(raw);
    if (re) {
      html = html.replace(re, (m0) => `<mark>${m0}</mark>`);
    }

    const item = div('sr-item', []);
    // 프리픽스 제거: row id, col 등은 표시하지 않음
    item.innerHTML = `<div class="sr-text">${html}</div>`;

    // 클릭 → 해당 로그 행으로 점프
    item.addEventListener('click', () => {
      dispatch({ type: 'JumpToRow', rowId: row.id });
    });

    el.searchResults.append(item);
  }
}

/* helpers */
function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
}
function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
