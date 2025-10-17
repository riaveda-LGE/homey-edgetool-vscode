// src/webviewers/log-viewer/views/GridHeaderView.ts
import type { ColumnId,Model, Msg } from '../app/types';
import { div, el, span } from './dom';

export function renderHeader(m: Model, dispatch:(msg:Msg)=>void){
  const show = m.showCols;

  // time | proc | pid | src | msg
  const cols =
    `${show.time?`${m.colW.time}px`:'0px'} ` +
    `${show.proc?`${m.colW.proc}px`:'0px'} ` +
    `${show.pid ?`${m.colW.pid }px`:'0px'} ` +
    `${show.src ?`${m.colW.src }px`:'0px'} ` +
    `${show.msg ? '1fr' : '0px'}`;

  el.logHeader.style.gridTemplateColumns = cols;

  // 하나라도 숨겨지면 gap=0으로 잔여 틈 제거
  const anyHidden = !(show.time && show.proc && show.pid && show.src && show.msg);
  el.logHeader.style.columnGap = anyHidden ? '0px' : '';

  el.logHeader.innerHTML = '';

  const col = (id: ColumnId, label: string, resizable: boolean) => {
    const c = div('lv-col-h', [
      span('', label),
      resizable ? resizer((dx,commit)=>dispatch({type:'ResizeColumn', col: id as any, dx, commit})) : null
    ]);
    c.classList.add(`h-${id}`);
    // ⚙️ 헤더 셀에 상대 배치 지정 → 리사이저를 절대배치로 우측 경계에 놓기 위함
    (c.style as any).position = 'relative';
    return c;
  };

  el.logHeader.append(
    col('time','시간', true),
    col('proc','프로세스', true),
    col('pid','PID', true),
    col('src','파일', true),
    col('msg','메시지', false),
  );

  // 숨겨진 컬럼은 가시 폭/보더/리사이저 제거 (모든 컬럼에 적용)
  applyHiddenStyles('time', !show.time);
  applyHiddenStyles('proc', !show.proc);
  applyHiddenStyles('pid',  !show.pid);
  applyHiddenStyles('src',  !show.src);
  applyHiddenStyles('msg',  !show.msg);
}

function applyHiddenStyles(id: ColumnId, hidden: boolean){
  const h = el.logHeader.querySelector(`.h-${id}`) as HTMLElement | null;
  if (!h) return;
  if (hidden) {
    h.classList.add('col-hidden');
    h.style.padding = '0';
    h.style.border = '0';
    h.style.minWidth = '0';
    h.style.width = '0';
    const rz = h.querySelector('.col-resizer') as HTMLElement | null;
    if (rz) { rz.style.display = 'none'; rz.style.width = '0'; }
  } else {
    h.classList.remove('col-hidden');
    const rz = h.querySelector('.col-resizer') as HTMLElement | null;
    if (rz) { rz.style.display = ''; rz.style.width = ''; }
  }
}

/* 리사이저: pointerdown 시에만 전역 리스너 바인딩 → 누수 방지
   + 인라인 스타일로 크기/커서/위치 지정 (CSS 없을 때도 동작 보장) */
function resizer(onDrag:(dx:number, commit:boolean)=>void){
  let lastX=0;
  const r = document.createElement('div');
  r.className='col-resizer';
  // 🔧 인라인 스타일: 우측 경계에 6px 핫존, 커서 표시
  r.style.position = 'absolute';
  r.style.top = '0';
  r.style.right = '-3px';   // 경계를 살짝 겹치게
  r.style.width = '6px';
  r.style.height = '100%';
  r.style.cursor = 'col-resize';
  r.style.touchAction = 'none';
  r.style.zIndex = '1';

  r.addEventListener('pointerdown', (e)=>{
    lastX=e.clientX;
    document.body.style.userSelect='none';
    try { r.setPointerCapture(e.pointerId); }catch{}
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - lastX; lastX = ev.clientX;
      onDrag(dx,false);
    };
    const onUp = (ev: PointerEvent) => {
      try { r.releasePointerCapture(ev.pointerId); }catch{}
      document.body.style.userSelect='';
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      onDrag(0,true);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  });
  return r;
}
