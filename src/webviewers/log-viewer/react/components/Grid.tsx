import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';

import { createUiLog } from '../../../shared/utils';
import { useLogStore } from '../../react/store';
import { vscode } from '../ipc';
import type { HighlightRule, LogRow } from '../types';
import { BookmarkSquare } from './BookmarkSquare';
import { GridHeader } from './GridHeader';
import { MessageDialog } from './MessageDialog';

export function Grid() {
  const parentRef = useRef(null as HTMLDivElement | null);
  const m = useLogStore();
  const [preview, setPreview] = useState({ open: false, logRow: null as LogRow | null });
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
    overscan: Math.max(10, Math.floor(m.overscan / 2)),
  });

  // mount/unmount 로그
  useEffect(() => {
    ui.info(`Grid.mount totalRows=${m.totalRows} windowStart=${m.windowStart}`);
    return () => ui.info('Grid.unmount');
  }, []);

  // Host 페이지 요청 (가상 스크롤 이동시)
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      const cur = parentRef.current;
      if (!cur) return;
      const estStart = Math.floor(cur.scrollTop / m.rowH) + m.windowStart;
      const desiredStart = clamp(
        estStart - Math.floor(m.overscan / 2),
        1,
        Math.max(1, m.totalRows - m.windowSize + 1),
      );
      const delta = Math.abs(desiredStart - m.windowStart);
      if (delta < Math.max(10, Math.floor(m.overscan / 2))) return;
      const startIdx = desiredStart;
      const endIdx = Math.min(m.totalRows, startIdx + m.windowSize - 1);
      ui.debug?.(
        `Grid.scroll → page.request start=${startIdx} end=${endIdx} estStart=${estStart} windowStart=${m.windowStart}`,
      );
      vscode?.postMessage({ v: 1, type: 'logs.page.request', payload: { startIdx, endIdx } });
    };
    el.addEventListener('scroll', onScroll, { passive: true } as AddEventListenerOptions);
    return () => el.removeEventListener('scroll', onScroll as unknown as EventListener);
  }, [m.rowH, m.windowStart, m.totalRows, m.windowSize, m.overscan]);

  // 프리뷰 상태 변경 로그
  useEffect(() => {
    ui.info(`Grid.preview state open=${preview.open} rowId=${preview.logRow?.id ?? 'none'}`);
  }, [preview.open, preview.logRow?.id]);

  // 마지막 보이는 컬럼이 항상 1fr이 되도록 그리드 트랙을 구성
  const buildGridTemplate = () => {
    // 본문 컬럼(time~msg)만 계산(토글 영향 받음)
    const tracks: string[] = [];
    const order: Array<keyof typeof m.showCols> = ['time', 'proc', 'pid', 'src', 'msg'];
    for (const id of order) {
      if (!m.showCols[id]) {
        // 숨김이면 0px 트랙(실질적으로 사라짐)
        tracks.push('0px');
      } else {
        if (id === 'time') tracks.push(`${m.colW.time}px`);
        else if (id === 'proc') tracks.push(`${m.colW.proc}px`);
        else if (id === 'pid') tracks.push(`${m.colW.pid}px`);
        else if (id === 'src') tracks.push(`${m.colW.src}px`);
        else if (id === 'msg') tracks.push('1fr');
      }
    }
    // msg가 꺼져 있으면 오른쪽에서부터 마지막 보이는 고정폭을 1fr로 승격
    if (!m.showCols.msg) {
      for (let i = tracks.length - 1; i >= 0; i--) {
        if (tracks[i] !== '0px') {
          tracks[i] = '1fr';
          break;
        }
      }
    }
    // 모든 컬럼이 숨겨졌을 때 안전장치
    if (!tracks.some((t) => t !== '0px')) tracks[0] = '1fr';
    // ⬇️ 항상 보이는 '북마크' 고정폭 열을 맨 앞에 추가
    return `var(--col-bm-w) ${tracks.join(' ')}`;
  };
  const gridCols = buildGridTemplate();
  const anyHidden = !(
    m.showCols.time &&
    m.showCols.proc &&
    m.showCols.pid &&
    m.showCols.src &&
    m.showCols.msg
  );

  // 현재 행 렌더에서 "가장 오른쪽 보이는 컬럼"을 구해 경계선을 지우기 위해 전달
  const lastVisibleCol: 'time' | 'proc' | 'pid' | 'src' | 'msg' | undefined = m.showCols.msg
    ? 'msg'
    : m.showCols.src
      ? 'src'
      : m.showCols.pid
        ? 'pid'
        : m.showCols.proc
          ? 'proc'
          : m.showCols.time
            ? 'time'
            : undefined;

  const totalSize = rowVirtualizer.getTotalSize();
  const virtualItems = rowVirtualizer.getVirtualItems();

  // ── 인덱스 점프 처리(북마크/검색 등) ────────────────────────────────
  useEffect(() => {
    const idx = m.pendingJumpIdx;
    if (!idx || !parentRef.current) return;
    const half = Math.floor(m.windowSize / 2);
    const startIdx = Math.max(1, Math.min(Math.max(1, m.totalRows - m.windowSize + 1), idx - half));
    const endIdx = Math.min(m.totalRows, startIdx + m.windowSize - 1);
    ui.info(`Grid.jumpToIdx idx=${idx} → request ${startIdx}-${endIdx}`);
    parentRef.current.scrollTop = Math.max(0, (idx - 1) * m.rowH);
    vscode?.postMessage({ v: 1, type: 'logs.page.request', payload: { startIdx, endIdx } });
  }, [m.pendingJumpIdx, m.windowSize, m.totalRows, m.rowH]);

  // pendingJumpIdx가 뷰포트로 로드되면 해당 행을 선택 상태로 확정
  useEffect(() => {
    const target = m.pendingJumpIdx;
    if (!target) return;
    const found = m.rows.find((r) => r.idx === target);
    if (found) {
      ui.info(`Grid.jump.resolve idx=${target} → rowId=${found.id}`);
      useLogStore.setState({ selectedRowId: found.id, pendingJumpIdx: undefined });
    }
  }, [m.pendingJumpIdx, m.rows]);

  return (
    <>
      <div
        ref={parentRef}
        className="tw-h-full tw-min-h-0 tw-overflow-y-auto tw-overflow-x-hidden tw-outline tw-outline-1 tw-outline-[var(--border)] tw-outline-offset-[-1px]"
      >
        {/* 헤더를 스크롤 컨테이너 내부로 이동 → 툴바는 고정, 헤더는 sticky */}
        <GridHeader />
        <div style={{ height: totalSize, position: 'relative' }}>
          {virtualItems.map((v) => {
            // v.index는 "전체 가상 인덱스(1-based → 0-based)".
            // 현재 버퍼(windowStart..windowStart+rows.length-1) 안에 있으면 매핑,
            // 아니면 placeholder(빈 셀)로 높이만 유지.
            const bufferStart0 = Math.max(0, m.windowStart - 1);
            const offset = v.index - bufferStart0;
            const r = offset >= 0 && offset < visibleRows.length ? visibleRows[offset] : undefined;

            // placeholder: 스크롤 높이 유지(실제 데이터는 아직 호스트에서 미수신)
            if (!r) {
              return (
                <div
                  key={`ph-${v.index}`}
                  style={{ position: 'absolute', top: v.start, left: 0, right: 0, height: v.size }}
                />
              );
            }
            const isSelected = m.selectedRowId === r.id;
            return (
              <div
                key={r.id}
                className={[
                  'tw-grid',
                  r.bookmarked
                    ? 'tw-bg-[color-mix(in_oklab,var(--row-selected)_20%,transparent_80%)]'
                    : '',
                  isSelected
                    ? 'tw-bg-[var(--row-focus)] tw-shadow-[inset_0_0_0_1px_var(--row-focus-border)]'
                    : '',
                ].join(' ')}
                style={{
                  position: 'absolute',
                  top: v.start,
                  left: 0,
                  right: 0,
                  height: v.size,
                  gridTemplateColumns: gridCols,
                  columnGap: anyHidden ? 0 : undefined,
                }}
                onClick={() => useLogStore.getState().jumpToRow(r.id, r.idx)}
                aria-selected={isSelected || undefined}
                /* 행 어디를 더블클릭해도 팝업이 뜨도록 보장 */
                onDoubleClick={(e) => {
                  // 더블클릭 이벤트 흐름 추적
                  e.preventDefault();
                  e.stopPropagation();
                  ui.info(
                    `Grid.row.dblclick id=${r.id} time="${r.time}" len=${r.raw?.length ?? r.msg.length} curOpen=${preview.open}`,
                  );
                  openPreview(r);
                }}
              >
                {/* ── 북마크 전용 열(항상 보임) ───────────────────────────── */}
                <div className="tw-flex tw-items-center tw-justify-center tw-border-b tw-border-[var(--row-divider)] tw-border-r tw-border-r-[var(--divider)]">
                  <BookmarkSquare
                    checked={!!r.bookmarked}
                    // 그리드 행 높이에 맞춰 버튼 크기 자동 조정(살짝 여유)
                    size={Math.max(18, Math.min(28, m.rowH - 6))}
                    title={r.bookmarked ? '북마크 해제' : '북마크'}
                    onClick={(e) => {
                      e.stopPropagation();
                      useLogStore.getState().toggleBookmark(r.id);
                    }}
                  />
                </div>
                <Cell
                  kind="time"
                  hidden={!m.showCols.time}
                  mono={false}
                  last={lastVisibleCol === 'time'}
                >
                  {hi(r.time, m.highlights)}
                </Cell>
                <Cell kind="proc" hidden={!m.showCols.proc} last={lastVisibleCol === 'proc'}>
                  {hi(r.proc, m.highlights)}
                </Cell>
                <Cell
                  kind="pid"
                  hidden={!m.showCols.pid}
                  align="right"
                  last={lastVisibleCol === 'pid'}
                >
                  {hi(r.pid, m.highlights)}
                </Cell>
                <Cell kind="src" hidden={!m.showCols.src} mono last={lastVisibleCol === 'src'}>
                  {hi(r.src ?? '', m.highlights)}
                </Cell>
                <Cell kind="msg" hidden={!m.showCols.msg} last={lastVisibleCol === 'msg'}>
                  {hi(r.msg, m.highlights)}
                </Cell>
              </div>
            );
          })}
        </div>
      </div>

      <MessageDialog
        isOpen={preview.open}
        logRow={preview.logRow}
        onClose={() => setPreview({ open: false, logRow: null })}
      />
    </>
  );
}

function Cell({
  children,
  hidden,
  mono,
  align,
  kind,
  last,
  onDoubleClick,
}: {
  children: React.ReactNode;
  hidden?: boolean;
  mono?: boolean;
  align?: 'left' | 'right';
  kind: 'time' | 'proc' | 'pid' | 'src' | 'msg';
  /** 이 셀이 마지막 보이는 컬럼인지(오른쪽 경계선/구분선 제거) */
  last?: boolean;
  onDoubleClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      onDoubleClick={onDoubleClick}
      className={`tw-min-w-0 tw-px-2 tw-py-[3px] tw-border-b tw-border-[var(--row-divider)]
      ${!last ? 'tw-border-r tw-border-r-[var(--divider)]' : ''}
      ${hidden ? 'tw-p-0 tw-border-0 tw-invisible tw-pointer-events-none' : ''}
      ${mono ? 'tw-font-mono' : ''}
      ${align === 'right' ? 'tw-text-right' : ''}
      tw-whitespace-nowrap tw-overflow-hidden tw-text-ellipsis`}
      aria-hidden={hidden || undefined}
    >
      {children}
    </div>
  );
}

function hi(text: string, rules: HighlightRule[]) {
  // 원본문자 HTML 이스케이프 후 하이라이트 적용 → XSS/깨짐 방지
  if (!rules.length) return text;
  let html = escapeHtml(text);
  for (const r of rules) {
    if (!r.text?.trim()) continue;
    const re = new RegExp(escapeRegExp(r.text.trim()), 'ig');
    const cls = r.color ? `hl-${r.color}` : '';
    html = html.replace(re, (m) => `<mark class="${cls}">${m}</mark>`);
  }
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function clamp(n: number, a: number, b: number) {
  return Math.min(b, Math.max(a, n));
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
