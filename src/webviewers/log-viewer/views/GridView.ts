// src/webviewers/log-viewer/views/GridView.ts
import type { HighlightRule, LogRow,Model, Msg } from '../app/types';
import { div, el, span } from './dom';

export function renderGrid(m: Model, dispatch:(msg:Msg)=>void){
  const show = m.showCols;
  (el.logGrid as any)._rowsById ||= new Map<number, HTMLElement>();
  const map: Map<number, HTMLElement> = (el.logGrid as any)._rowsById;

  const prevScrollTop = el.logGrid.scrollTop;
  el.logGrid.style.position = 'relative';
  // 행 높이 CSS 변수 반영
  el.logGrid.style.setProperty('--row-h', `${m.rowH}px`);

  el.logGrid.style.setProperty('--col-time-w', `${m.colW.time}px`);
  el.logGrid.style.setProperty('--col-proc-w', `${m.colW.proc}px`);
  el.logGrid.style.setProperty('--col-pid-w',  `${m.colW.pid}px`);
  el.logGrid.style.setProperty('--col-src-w',  `${m.colW.src}px`);

  el.logGrid.innerHTML = '';
  map.clear();

  const cols =
    `${show.time?`${m.colW.time}px`:'0px'} ` +
    `${show.proc?`${m.colW.proc}px`:'0px'} ` +
    `${show.pid ?`${m.colW.pid }px`:'0px'} ` +
    `${show.src ?`${m.colW.src }px`:'0px'} ` +
    `${show.msg ? '1fr' : '0px'}`;

  // 하나라도 숨겨지면 gap=0으로 줄무늬 제거
  const anyHidden = !(show.time && show.proc && show.pid && show.src && show.msg);
  (el.logGrid as HTMLElement).style.columnGap = anyHidden ? '0px' : '';

  // ── 가상 스크롤용 spacer: windowStart 기준 상/하단 빈 영역
  const topSpacePx =
    Math.max(0, (m.windowStart - 1)) * m.rowH;
  const bottomStart = m.windowStart + m.rows.length;      // 다음 전역 인덱스
  const bottomCount = Math.max(0, (m.totalRows + 1) - bottomStart);
  const bottomSpacePx = bottomCount * m.rowH;

  const spacerTop = div('lv-spacer', []);
  spacerTop.style.height = `${topSpacePx}px`;
  el.logGrid.append(spacerTop);

  // 현재 창(window)만 렌더
  for (const r of m.rows){
    const row = div('lv-row', [], { 'data-id': String(r.id) });
    if (r.bookmarked) row.classList.add('bookmarked');
    if (m.selectedRowId === r.id) row.classList.add('selected');

    row.style.gridTemplateColumns = cols;

    const star = span('lv-star','');
    star.addEventListener('click', (e)=>{ e.stopPropagation(); dispatch({type:'ToggleBookmark', rowId: r.id}); });

    const hi = (text: string) => applyHighlights(text, m.highlights);

    const cTime = cell('time', hi(r.time));
    const cProc = cell('proc', hi(r.proc));
    const cPid  = cell('pid',  hi(r.pid));
    const cSrc  = cell('src',  hi(r.src ?? ''));
    const cMsg  = cell('msg',  hi(r.msg));

    // 숨김 컬럼은 가시 요소 폭/패딩/보더 제거 (모든 컬럼)
    applyCellHidden(cTime, !show.time);
    applyCellHidden(cProc, !show.proc);
    applyCellHidden(cPid,  !show.pid);
    applyCellHidden(cSrc,  !show.src);
    applyCellHidden(cMsg,  !show.msg);

    cMsg.addEventListener('dblclick', ()=>{
      const raw = buildRawLine(r);
      dispatch({type:'OpenMsgModal', text: raw});
    });

    cTime.prepend(star);
    row.append(cTime, cProc, cPid, cSrc, cMsg);

    row.addEventListener('click', ()=>dispatch({ type:'JumpToRow', rowId: r.id }));
    el.logGrid.append(row);
    map.set(r.id, row);
  }

  const spacerBottom = div('lv-spacer', []);
  spacerBottom.style.height = `${bottomSpacePx}px`;
  el.logGrid.append(spacerBottom);

  if (!(el.logGrid as any)._boxSelBound) {
    (el.logGrid as any)._boxSelBound = true;
    installBoxSelection(el.logGrid, (_phase, _rect)=>{ /* 필요시 연결 */ });
  }

  if (m.selectedRowId){
    const rowEl = map.get(m.selectedRowId);
    if (rowEl){
      const gridRect = el.logGrid.getBoundingClientRect();
      const rowRect = rowEl.getBoundingClientRect();
      el.logGrid.scrollTop += (rowRect.top - gridRect.top) - gridRect.height/3;
    }
  }

  // 렌더링 후 scrollTop 복원(리스트 교체시 점프 방지)
  el.logGrid.scrollTop = prevScrollTop;
}

function cell(kind: 'time'|'proc'|'pid'|'src'|'msg', content: Node){
  const c = document.createElement('div');
  c.className = `lv-cell ${kind}`;
  c.append(content);
  return c;
}

function applyCellHidden(c: HTMLElement, hidden: boolean){
  if (!hidden) {
    c.classList.remove('col-hidden');
    c.style.padding = '';
    c.style.border = '';
    (c.style as any).minWidth = '';
    c.style.width = '';
    return;
  }
  c.classList.add('col-hidden');
  c.style.padding = '0';
  c.style.border = '0';
  (c.style as any).minWidth = '0';
  c.style.width = '0';
}

function applyHighlights(text: string, rules: HighlightRule[]){
  if (!rules.length) return document.createTextNode(text);
  let html = text;
  for (const r of rules){
    if (!r.text) continue;
    const re = new RegExp(r.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
    const cls = r.color ? ` class="hl-${r.color}"` : '';
    html = html.replace(re, m => `<mark${cls}>${m}</mark>`);
  }
  const spanEl = document.createElement('span');
  spanEl.innerHTML = html;
  return spanEl;
}

function buildRawLine(r: LogRow){
  const src = r.src ? ` {${r.src}}` : '';
  return `[${r.time}] ${r.proc}[${r.pid}]${src}:  ${r.msg}`;
}

// 선택 박스 유틸
function installBoxSelection(container: HTMLElement, cb:(phase:'start'|'move'|'end', rect:DOMRect)=>void){
  let dragging=false; let startX=0, startY=0; let box:HTMLDivElement|null=null;
  const toRect = (x1:number,y1:number,x2:number,y2:number):DOMRect => {
    const left = Math.min(x1,x2), top = Math.min(y1,y2);
    const right = Math.max(x1,x2), bottom = Math.max(y1,y2);
    return new DOMRect(left, top, right-left, bottom-top);
  };
  container.addEventListener('pointerdown', (e)=>{
    if (e.button!==0) return;
    dragging=true; startX=e.clientX; startY=e.clientY;
    box = document.createElement('div'); box.className='lv-select-rect';
    container.append(box);
    const r = toRect(startX,startY,startX,startY);
    place(box, r, container); cb('start', r);
  });
  window.addEventListener('pointermove', (e)=>{
    if(!dragging||!box) return;
    const r = toRect(startX,startY,e.clientX,e.clientY);
    place(box, r, container); cb('move', r);
  }, {passive:true});
  window.addEventListener('pointerup', ()=>{
    if(!dragging) return;
    dragging=false;
    if (box && box.parentElement) box.parentElement.removeChild(box);
    box = null; cb('end', new DOMRect(0,0,0,0));
  });
}
function place(box:HTMLElement, rect:DOMRect, container:HTMLElement){
  const c = container.getBoundingClientRect();
  box.style.left = `${rect.left - c.left + container.scrollLeft}px`;
  box.style.top  = `${rect.top  - c.top  + container.scrollTop }px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
}
