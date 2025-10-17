// src/webviewers/log-viewer/views/BookmarksView.ts
import type { Model, Msg } from '../app/types';
import { div, el, text } from './dom';

export function renderBookmarks(m: Model, dispatch:(msg:Msg)=>void){
  const hasAny = m.rows.some(r => r.bookmarked);
  const visible = m.showBookmarks && hasAny;

  if (visible){
    el.bookmarkPane.hidden = false;
    el.midSplitter.hidden = false;
    el.main.classList.add('has-bookmarks');
  }else{
    el.bookmarkPane.hidden = true;
    el.midSplitter.hidden = true;
    el.main.classList.remove('has-bookmarks');
  }
  el.bmList.innerHTML = '';
  for (const r of m.rows){
    if (!r.bookmarked) continue;
    const it = div('bm-item', [text(`${r.time} — ${r.msg.slice(0,60)}`)]);
    it.addEventListener('click', ()=>dispatch({ type:'JumpToRow', rowId: r.id }));
    el.bmList.append(it);
  }
}
