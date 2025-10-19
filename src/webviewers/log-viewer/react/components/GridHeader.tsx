import { useRef } from 'react';
import { useLogStore } from '../../react/store';

export function GridHeader(){
  const show = useLogStore(s=>s.showCols);
  const colW = useLogStore(s=>s.colW);
  const resize = useLogStore(s=>s.resizeColumn);

  const cols =
    `${show.time?`${colW.time}px`:'0px'} ` +
    `${show.proc?`${colW.proc}px`:'0px'} ` +
    `${show.pid ?`${colW.pid }px`:'0px'} ` +
    `${show.src ?`${colW.src }px`:'0px'} ` +
    `${show.msg ? '1fr' : '0px'}`;

  const anyHidden = !(show.time && show.proc && show.pid && show.src && show.msg);

  return (
    <div className="tw-sticky tw-top-0 tw-bg-[var(--panel)] tw-border-b tw-border-[var(--border-strong)] tw-z-[1]"
         style={{ display:'grid', gridTemplateColumns: cols, columnGap: anyHidden ? 0 : undefined }}>
      {col('time','시간', true, (dx)=>resize('time',dx), !show.time)}
      {col('proc','프로세스', true, (dx)=>resize('proc',dx), !show.proc)}
      {col('pid','PID', true, (dx)=>resize('pid',dx), !show.pid)}
      {col('src','파일', true, (dx)=>resize('src',dx), !show.src)}
      {col('msg','메시지', false, ()=>{}, !show.msg)}
    </div>
  );
}

function col(id:string, label:string, resizable:boolean, onDrag:(dx:number)=>void, hidden:boolean){
  const ref = useRef(null as HTMLDivElement | null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (!resizable) return;
    let last = e.clientX;
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      document.body.style.userSelect = '';
    };
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - last; last = ev.clientX; onDrag(dx);
      ev.preventDefault();
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  };

  return (
    <div
      ref={ref}
      className={`tw-relative tw-flex tw-items-center tw-gap-1 tw-px-2 tw-py-1 tw-border-r tw-border-[var(--divider-strong)]
        ${hidden?'tw-p-0 tw-border-0':''}`}
    >
      <span className="tw-text-sm tw-truncate">{label}</span>
      {/* 시각적인 구분선(항상 보임, 1px) */}
      {resizable && (
        <div className="tw-absolute tw-right-[4px] tw-top-1 tw-bottom-1 tw-w-px tw-bg-[var(--divider)] tw-pointer-events-none" />
      )}
      {/* 리사이저 핸들(기존 8px → 4px, 반투명) */}
      {resizable && (
        <div
          className="tw-absolute tw-right-0 tw-top-0 tw-bottom-0 tw-w-[4px] tw-rounded tw-cursor-col-resize
                     tw-bg-[var(--resizer)] hover:tw-bg-[var(--resizer-hover)] tw-opacity-40 hover:tw-opacity-80"
          onPointerDown={onPointerDown}
          title="드래그하여 폭 조절"
        />
      )}
    </div>
  );
}
