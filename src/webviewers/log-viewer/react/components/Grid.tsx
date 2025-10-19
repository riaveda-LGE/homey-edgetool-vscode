import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useLogStore } from '../../react/store';
import type { HighlightRule, LogRow } from '../types';
import { vscode } from '../ipc';
import { GridHeader } from './GridHeader';
import { MessageDialog } from './MessageDialog';
import { createUiLog } from '../../../shared/utils';

export function Grid(){
  const parentRef = useRef(null as HTMLDivElement | null);
  const m = useLogStore();
  const [preview, setPreview] = useState({open:false, logRow:null as LogRow|null});
  // grid 전용 ui logger
  const ui = useMemo(() => createUiLog(vscode, 'log-viewer.grid'), []);
  // 더블클릭 → Dialog 오픈 시 잔여 click 이벤트가 먼저 발생하지 않도록 약간 지연
  const DIALOG_OPEN_DELAY_MS = 40;
  const openPreview = (row: LogRow) => {
    ui.info(`Grid.openPreview.schedule id=${row.id} delay=${DIALOG_OPEN_DELAY_MS}ms`);
    setTimeout(() => {
      ui.info(`Grid.openPreview.commit id=${row.id}`);
      setPreview({ open: true, logRow: row });
    }, DIALOG_OPEN_DELAY_MS);
  };

  const visibleRows = m.rows;
  const rowVirtualizer = useVirtualizer({
    // 스크롤 높이는 전체(필터 반영) 총 라인 수를 기준으로 만든다
    count: Math.max(0, m.totalRows),
    getScrollElement: () => parentRef.current,
    estimateSize: () => m.rowH,
    overscan: Math.max(10, Math.floor(m.overscan/2)),
  });

  // mount/unmount 로그
  useEffect(() => {
    ui.info(`Grid.mount totalRows=${m.totalRows} windowStart=${m.windowStart}`);
    return () => ui.info('Grid.unmount');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Host 페이지 요청 (가상 스크롤 이동시)
  useEffect(()=>{
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      const cur = parentRef.current;
      if (!cur) return;
      const estStart = Math.floor(cur.scrollTop / m.rowH) + m.windowStart;
      const desiredStart = clamp(estStart - Math.floor(m.overscan/2), 1, Math.max(1, m.totalRows - m.windowSize + 1));
      const delta = Math.abs(desiredStart - m.windowStart);
      if (delta < Math.max(10, Math.floor(m.overscan/2))) return;
      const startIdx = desiredStart;
      const endIdx = Math.min(m.totalRows, startIdx + m.windowSize - 1);
      ui.debug?.(`Grid.scroll → page.request start=${startIdx} end=${endIdx} estStart=${estStart} windowStart=${m.windowStart}`);
      vscode?.postMessage({ v:1, type:'logs.page.request', payload:{ startIdx, endIdx }});
    };
    el.addEventListener('scroll', onScroll, { passive:true } as AddEventListenerOptions);
    return () => el.removeEventListener('scroll', onScroll as unknown as EventListener);
  }, [m.rowH, m.windowStart, m.totalRows, m.windowSize, m.overscan]);

  // 프리뷰 상태 변경 로그
  useEffect(()=>{ ui.info(`Grid.preview state open=${preview.open} rowId=${preview.logRow?.id ?? 'none'}`); }, [preview.open, preview.logRow?.id]);

  const gridCols =
    `${m.showCols.time?`${m.colW.time}px`:'0px'} ` +
    `${m.showCols.proc?`${m.colW.proc}px`:'0px'} ` +
    `${m.showCols.pid ?`${m.colW.pid }px`:'0px'} ` +
    `${m.showCols.src ?`${m.colW.src }px`:'0px'} ` +
    `${m.showCols.msg ? '1fr' : '0px'}`;
  const anyHidden = !(m.showCols.time && m.showCols.proc && m.showCols.pid && m.showCols.src && m.showCols.msg);

  const totalSize = rowVirtualizer.getTotalSize();
  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <>
      <div
        ref={parentRef}
        className="tw-h-full tw-min-h-0 tw-overflow-y-auto tw-overflow-x-hidden tw-outline tw-outline-1 tw-outline-[var(--border)] tw-outline-offset-[-1px]"
      >
        {/* 헤더를 스크롤 컨테이너 내부로 이동 → 툴바는 고정, 헤더는 sticky */}
        <GridHeader />
        <div style={{ height: totalSize, position:'relative' }}>
        {virtualItems.map(v => {
          // v.index는 "전체 가상 인덱스(1-based → 0-based)".
          // 현재 버퍼(windowStart..windowStart+rows.length-1) 안에 있으면 매핑,
          // 아니면 placeholder(빈 셀)로 높이만 유지.
          const bufferStart0 = Math.max(0, m.windowStart - 1);
          const offset = v.index - bufferStart0;
          const r = (offset >= 0 && offset < visibleRows.length) ? visibleRows[offset] : undefined;

          // placeholder: 스크롤 높이 유지(실제 데이터는 아직 호스트에서 미수신)
          if (!r) {
            return (
              <div
                key={`ph-${v.index}`}
                style={{ position:'absolute', top: v.start, left:0, right:0, height: v.size }}
              />
            );
          }
          return (
            <div
              key={r.id}
              className={`tw-grid ${r.bookmarked?'tw-bg-[color-mix(in_oklab,var(--row-selected)_20%,transparent_80%)]':''}`}
              style={{
                position:'absolute', top: v.start, left:0, right:0, height: v.size,
                gridTemplateColumns: gridCols, columnGap: anyHidden ? 0 : undefined
              }}
              onClick={()=>useLogStore.getState().jumpToRow(r.id)}
              /* 행 어디를 더블클릭해도 팝업이 뜨도록 보장 */
              onDoubleClick={(e)=>{
                // 더블클릭 이벤트 흐름 추적
                e.preventDefault();
                e.stopPropagation();
                ui.info(`Grid.row.dblclick id=${r.id} time="${r.time}" len=${(r.raw?.length ?? r.msg.length)} curOpen=${preview.open}`);
                openPreview(r);
              }}
            >
              <Cell kind="time" hidden={!m.showCols.time} mono={false}>
                <span className="tw-mr-1 tw-cursor-pointer" onClick={(e)=>{ e.stopPropagation(); useLogStore.getState().toggleBookmark(r.id); }}> {r.bookmarked ? '★' : '☆'} </span>
                {hi(r.time, m.highlights)}
              </Cell>
              <Cell kind="proc" hidden={!m.showCols.proc}>{hi(r.proc, m.highlights)}</Cell>
              <Cell kind="pid" hidden={!m.showCols.pid} align="right">{hi(r.pid, m.highlights)}</Cell>
              <Cell kind="src" hidden={!m.showCols.src} mono>{hi(r.src ?? '', m.highlights)}</Cell>
              <Cell kind="msg" hidden={!m.showCols.msg}>{hi(r.msg, m.highlights)}</Cell>
            </div>
          );
        })}
        </div>
      </div>

      <MessageDialog
        isOpen={preview.open}
        logRow={preview.logRow}
        onClose={()=>setPreview({open:false, logRow:null})}
      />
    </>
  );
}

function Cell({ children, hidden, mono, align, kind, onDoubleClick }:{
  children: React.ReactNode;
  hidden?: boolean;
  mono?: boolean;
  align?: 'left'|'right';
  kind:'time'|'proc'|'pid'|'src'|'msg';
  onDoubleClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}){
  return (
    <div
      onDoubleClick={onDoubleClick}
      className={`tw-min-w-0 tw-px-2 tw-py-[3px] tw-border-b tw-border-[var(--row-divider)]
      ${kind!=='msg'?'tw-border-r tw-border-r-[var(--divider)]':''}
      ${hidden?'tw-p-0 tw-border-0':''}
      ${mono?'tw-font-mono':''}
      ${align==='right'?'tw-text-right':''}
      tw-whitespace-nowrap tw-overflow-hidden tw-text-ellipsis`}
    >
      {children}
    </div>
  );
}

function hi(text: string, rules: HighlightRule[]){
  // 원본문자 HTML 이스케이프 후 하이라이트 적용 → XSS/깨짐 방지
  if (!rules.length) return text;
  let html = escapeHtml(text);
  for (const r of rules){
    if (!r.text?.trim()) continue;
    const re = new RegExp(escapeRegExp(r.text.trim()), 'ig');
    const cls = r.color ? `hl-${r.color}` : '';
    html = html.replace(re, (m)=>`<mark class="${cls}">${m}</mark>`);
  }
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function clamp(n:number,a:number,b:number){ return Math.min(b, Math.max(a,n)); }

function escapeHtml(s: string) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}
