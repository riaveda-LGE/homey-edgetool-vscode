import { useRef } from 'react';

import { createUiMeasure } from '../../../shared/utils';
import { createUiLog } from '../../../shared/utils';
import { useLogStore } from '../../react/store';
import { vscode } from '../ipc';

export function GridHeader() {
  const show = useLogStore((s) => s.showCols);
  const colW = useLogStore((s) => s.colW);
  const resize = useLogStore((s) => s.resizeColumn);
  const measureUi = useLogStore((s) => s.measureUi);
  const totalRows = useLogStore((s) => s.totalRows);
  // grid header 전용 ui logger
  const ui = createUiLog(vscode, 'log-viewer.grid-header');

  // 그리드와 동일하게: 마지막 보이는 컬럼은 1fr
  const buildGridTemplate = () => {
    // 본문 컬럼(time~msg)만 계산
    const tracks: string[] = [];
    const vis = { ...show };
    const push = (on: boolean, px: string) => tracks.push(on ? px : '0px');
    push(vis.time, `${colW.time}px`);
    push(vis.proc, `${colW.proc}px`);
    push(vis.pid, `${colW.pid}px`);
    push(vis.src, `${colW.src}px`);
    tracks.push(vis.msg ? '1fr' : '0px');
    if (!vis.msg) {
      for (let i = tracks.length - 1; i >= 0; i--) {
        if (tracks[i] !== '0px') {
          tracks[i] = '1fr';
          break;
        }
      }
    }
    if (!tracks.some((t) => t !== '0px')) tracks[0] = '1fr';
    // ⬇️ 항상 보이는 '북마크' 고정폭 열 + '인덱스' 고정폭 열을 앞에 추가
    return `var(--col-bm-w) var(--col-idx-w) ${tracks.join(' ')}`;
  };
  const cols = buildGridTemplate();

  // 인덱스 열 너비(총행수 자릿수 기반)
  const idxWidthPx = (() => {
    const digits = Math.max(2, String(Math.max(1, totalRows || 0)).length);
    return Math.min(120, Math.max(48, 14 + digits * 8));
  })();

  const anyHidden = !(show.time && show.proc && show.pid && show.src && show.msg);

  // 헤더에서도 마지막 보이는 컬럼 식별(구분선/리사이저 숨김)
  const lastVisible: 'time' | 'proc' | 'pid' | 'src' | 'msg' | undefined = show.msg
    ? 'msg'
    : show.src
      ? 'src'
      : show.pid
        ? 'pid'
        : show.proc
          ? 'proc'
          : show.time
            ? 'time'
            : undefined;

  const col = (
    id: string,
    label: string,
    resizable: boolean,
    onDrag: (dx: number) => void,
    hidden: boolean,
    isLast: boolean,
  ) => {
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
        const dx = ev.clientX - last;
        last = ev.clientX;
        onDrag(dx);
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
          ${hidden ? 'tw-p-0 tw-border-0 tw-invisible tw-pointer-events-none' : ''}`}
        style={{ borderRight: isLast ? '0' : undefined }}
        aria-hidden={hidden || undefined}
      >
        <span className="tw-text-sm tw-truncate">{label}</span>
        {/* 시각적인 구분선(항상 보임, 1px) */}
        {resizable && !isLast && !hidden && (
          <div className="tw-absolute tw-right-[4px] tw-top-1 tw-bottom-1 tw-w-px tw-bg-[var(--divider)] tw-pointer-events-none" />
        )}
        {/* 리사이저 핸들(기존 8px → 4px, 반투명) */}
        {resizable && !isLast && !hidden && (
          <div
            className="tw-absolute tw-right-0 tw-top-0 tw-bottom-0 tw-w-[4px] tw-rounded tw-cursor-col-resize
                       tw-bg-[var(--resizer)] hover:tw-bg-[var(--resizer-hover)] tw-opacity-40 hover:tw-opacity-80"
            onPointerDown={onPointerDown}
            title="드래그하여 폭 조절"
          />
        )}
      </div>
    );
  };

  return (
    <div
      className="tw-sticky tw-top-0 tw-bg-[var(--panel)] tw-border-b tw-border-[var(--border-strong)] tw-z-[1]"
      style={{
        display: 'grid',
        gridTemplateColumns: cols,
        columnGap: anyHidden ? 0 : undefined,
        // CSS Custom Property 주입
        ['--col-idx-w' as any]: `${idxWidthPx}px`,
      }}
    >
      {/* 북마크 헤더(비어있는 고정 폭 컬럼, 오른쪽 구분선 유지) */}
      <div className="tw-px-2 tw-py-1 tw-border-r tw-border-[var(--divider-strong)]" aria-hidden />
      {/* 인덱스 헤더(우측 정렬, 모노스페이스) */}
      <div className="tw-px-2 tw-py-1 tw-border-r tw-border-[var(--divider-strong)] tw-text-right tw-font-mono tw-tabular-nums">
        #
      </div>
      {col(
        'time',
        '시간',
        true,
        (dx) => measureUi('GridHeader.resize.time', () => resize('time', dx)),
        !show.time,
        lastVisible === 'time',
      )}
      {col(
        'proc',
        '프로세스',
        true,
        (dx) => measureUi('GridHeader.resize.proc', () => resize('proc', dx)),
        !show.proc,
        lastVisible === 'proc',
      )}
      {col(
        'pid',
        'PID',
        true,
        (dx) => measureUi('GridHeader.resize.pid', () => resize('pid', dx)),
        !show.pid,
        lastVisible === 'pid',
      )}
      {col(
        'src',
        '파일',
        true,
        (dx) => measureUi('GridHeader.resize.src', () => resize('src', dx)),
        !show.src,
        lastVisible === 'src',
      )}
      {col('msg', '메시지', false, () => {}, !show.msg, lastVisible === 'msg')}
    </div>
  );
}
