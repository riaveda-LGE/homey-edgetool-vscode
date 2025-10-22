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
  // 헤더가 같은 스크롤 컨테이너 안에 있으므로 실제 리스트 시작점 보정용
  const listRef = useRef(null as HTMLDivElement | null);
  const m = useLogStore();
  const [preview, setPreview] = useState({ open: false, logRow: null as LogRow | null });
  // grid 전용 ui logger
  const ui = useMemo(() => createUiLog(vscode, 'log-viewer.grid'), []);

  // 동일 요청 범위 중복 송신 방지 (훅은 반드시 최상위에서 선언)
  const lastReqRef = useRef<{ s: number; e: number } | null>(null);

  // ── 로그 스로틀/디듀프 유틸 ─────────────────────────────
  // (과도한 로그로 성능/가독성 저하 방지)
  const lastLogTsRef = useRef(new Map<string, number>());
  const lastPayloadRef = useRef(new Map<string, string>());
  const shouldLog = (key: string, ms = 400, payloadStr?: string) => {
    const now = performance.now();
    const last = lastLogTsRef.current.get(key) ?? -Infinity;
    if (payloadStr && lastPayloadRef.current.get(key) === payloadStr) return false; // 동일 payload 반복 제거
    if (now - last < ms) return false; // 스로틀
    lastLogTsRef.current.set(key, now);
    if (payloadStr) lastPayloadRef.current.set(key, payloadStr);
    return true;
  };

  // 더블클릭 → Dialog 오픈 시 잔여 click 이벤트가 먼저 발생하지 않도록 약간 지연
  const DIALOG_OPEN_DELAY_MS = 40;
  const openPreview = (row: LogRow) => {
    ui.debug?.('[debug] Grid: openPreview start');
    ui.info(`Grid.openPreview.schedule id=${row.id} delay=${DIALOG_OPEN_DELAY_MS}ms`);
    setTimeout(() => {
      ui.info(`Grid.openPreview.commit id=${row.id}`);
      setPreview({ open: true, logRow: row });
    }, DIALOG_OPEN_DELAY_MS);
    ui.debug?.('[debug] Grid: openPreview end');
  };

  const visibleRows = m.rows;
  const rowVirtualizer = useVirtualizer({
    // 스크롤 높이는 전체(필터 반영) 총 라인 수를 기준으로 만든다
    count: Math.max(0, m.totalRows),
    getScrollElement: () => parentRef.current,
    estimateSize: () => m.rowH,
    overscan: Math.max(10, Math.floor(m.overscan / 2)),
  });

  // scroll 이벤트 중복 방지 플래그
  const ignoreScrollRef = useRef(false);
  const lastWindowStartChangeTimeRef = useRef(0);
  // 최초/리프레시 이후 단 한 번만 아래로 앵커링
  const initialAnchoredRef = useRef(false);
  const wasEmptyRef = useRef(true);
  const AUTO_PAUSE_TOLERANCE_ROWS = 2; // 바닥에서 이만큼 벗어나면 PAUSE

  // mount/unmount 로그 + 기본 측정값
  useEffect(() => {
    ui.info(`Grid.mount totalRows=${m.totalRows} windowStart=${m.windowStart}`);
    // 컨테이너 측정(높이, DPR) — 스로틀
    const logMeasure = () => {
      const h = parentRef.current?.clientHeight ?? 0;
      const p = window.devicePixelRatio ?? 1;
      const cap = m.rowH > 0 ? Math.floor(h / Math.round(m.rowH)) : 0;
      const payload = `h=${h} rowH=${m.rowH} dpr=${p} capacity=${cap}`;
      if (shouldLog('measure', 800, payload)) ui.info(`Grid.measure ${payload}`);
    };
    logMeasure();
    // Webview/old env 가드
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => logMeasure());
      if (parentRef.current) {
        ro.observe(parentRef.current);
      }
    }
    return () => {
      ui.info('Grid.unmount');
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Host 페이지 요청 (가상 스크롤 이동시)
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    const onScroll = () => {
      // 프로그램적 스크롤 보정 중에는 요청 차단
      if (ignoreScrollRef.current || Date.now() - lastWindowStartChangeTimeRef.current < 100) return;

      const cur = parentRef.current;
      if (!cur) return;

      const headerOffset = listRef.current?.offsetTop ?? 0;
      const estStart = Math.floor(Math.max(0, cur.scrollTop - headerOffset) / Math.max(1, m.rowH)) + 1;

      const capacity = Math.max(1, Math.floor((cur.clientHeight || 0) / Math.max(1, Math.round(m.rowH))));
      // 요청 폭을 뷰포트 용량 + overscan 으로 확장하되, windowSize 를 넘지 않도록 제한
      const requestSize = Math.max(capacity, Math.min(m.windowSize, capacity + m.overscan));
      // 스크롤 시작점의 상한선은 "요청 폭" 기준으로 계산해야 하단에서 빈칸이 줄어듦
      const maxStart = Math.max(1, m.totalRows - requestSize + 1);

      const halfOver = Math.floor(m.overscan / 2);
      const desiredStartRaw = estStart - halfOver;
      const desiredStart = Math.min(Math.max(1, desiredStartRaw), maxStart);

      const delta = Math.abs(desiredStart - m.windowStart);
      if (delta < Math.max(10, halfOver)) return; // 자잘한 스크롤 억제

      const startIdx = desiredStart;
      const endIdx = Math.min(m.totalRows, startIdx + requestSize - 1);

      // 동일 범위 중복 요청 방지
      if (lastReqRef.current && lastReqRef.current.s === startIdx && lastReqRef.current.e === endIdx) return;
      lastReqRef.current = { s: startIdx, e: endIdx };

      const payload = `start=${startIdx} end=${endIdx} estStart=${estStart} cap=${capacity} req=${requestSize} maxStart=${maxStart} windowStart=${m.windowStart}`;
      if (shouldLog('page.request', 200, payload)) {
        ui.debug?.(`Grid.scroll → page.request ${payload}`);
      }
      vscode?.postMessage({ v: 1, type: 'logs.page.request', payload: { startIdx, endIdx } });

      // ✅ FOLLOW 자동 해제: 사용자가 바닥 근처를 벗어나면 PAUSE로 전환
      const nearBottom =
        cur.scrollTop + cur.clientHeight >= cur.scrollHeight - m.rowH * (AUTO_PAUSE_TOLERANCE_ROWS + 0.5);
      if (m.follow && !nearBottom) {
        useLogStore.getState().setFollow(false);
        ui.info('Grid.scroll: auto-pause follow (scrolled away from bottom)');
      }
    };

    el.addEventListener('scroll', onScroll, { passive: true } as AddEventListenerOptions);
    return () => el.removeEventListener('scroll', onScroll as unknown as EventListener);
  }, [m.rowH, m.windowStart, m.totalRows, m.overscan, m.windowSize, m.follow]);

  // 프리뷰 상태 변경 로그
  useEffect(() => {
    ui.info(`Grid.preview state open=${preview.open} rowId=${preview.logRow?.id ?? 'none'}`);
  }, [preview.open, preview.logRow?.id]);

  // 마지막 보이는 컬럼이 항상 1fr이 되도록 그리드 트랙을 구성
  const gridCols = useMemo(() => {
    ui.debug?.('[debug] Grid: buildGridTemplate start');
    // 본문 컬럼(time~msg)만 계산(토글 영향 받음)
    const tracks: string[] = [];
    const order: Array<keyof typeof m.showCols> = ['time', 'proc', 'pid', 'src', 'msg'];
    for (const id of order) {
      if (!m.showCols[id]) {
        tracks.push('0px');
      } else {
        if (id === 'time') tracks.push(`${m.colW.time}px`);
        else if (id === 'proc') tracks.push(`${m.colW.proc}px`);
        else if (id === 'pid') tracks.push(`${m.colW.pid}px`);
        else if (id === 'src') tracks.push(`${m.colW.src}px`);
        else if (id === 'msg') tracks.push('1fr');
      }
    }
    if (!m.showCols.msg) {
      for (let i = tracks.length - 1; i >= 0; i--) {
        if (tracks[i] !== '0px') {
          tracks[i] = '1fr';
          break;
        }
      }
    }
    if (!tracks.some((t) => t !== '0px')) tracks[0] = '1fr';
    ui.debug?.('[debug] Grid: buildGridTemplate end');
    return `var(--col-bm-w) ${tracks.join(' ')}`;
  }, [m.showCols.time, m.showCols.proc, m.showCols.pid, m.showCols.src, m.showCols.msg, m.colW.time, m.colW.proc, m.colW.pid, m.colW.src]);
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
    // 점프 시에만 프로그램적 스크롤 적용(+ onScroll 무시)
    ignoreScrollRef.current = true;
    lastWindowStartChangeTimeRef.current = Date.now();
    const headerOffset = listRef.current?.offsetTop ?? 0;
    parentRef.current.scrollTop = headerOffset + Math.max(0, (idx - 1) * m.rowH);
    // 다음 프레임에서 해제
    requestAnimationFrame(() => {
      ignoreScrollRef.current = false;
    });
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

  // ── 수신 커버리지 요약(중복/과다 로그 억제) ─────────────────────────
  const lastCoverageRef = useRef<string>('');
  useEffect(() => {
    if (!m.totalRows) return;
    const start = m.windowStart;
    const end = m.windowStart + Math.max(0, visibleRows.length) - 1;
    const cov = start <= end ? `${start}-${end}` : 'empty';
    if (cov !== lastCoverageRef.current && shouldLog('coverage', 400, cov)) {
      ui.info(`Grid.coverage loaded=${cov} len=${visibleRows.length}/${m.windowSize}`);
      lastCoverageRef.current = cov;
    }
  }, [m.windowStart, visibleRows.length, m.windowSize, m.totalRows]);

  // ── 공통: 맨 아래로 앵커링 함수 ──────────────────────────────────────
  const scrollToBottom = () => {
    const el = parentRef.current;
    const list = listRef.current;
    if (!el || !list) return;
    const headerOffset = list.offsetTop || 0;
    const endIdx = m.windowStart + m.rows.length - 1;
    const target = headerOffset + endIdx * Math.max(1, m.rowH) - el.clientHeight;
    ignoreScrollRef.current = true;
    lastWindowStartChangeTimeRef.current = Date.now();
    el.scrollTop = Math.max(0, Math.min(target, el.scrollHeight - el.clientHeight));
    requestAnimationFrame(() => {
      ignoreScrollRef.current = false;
    });
    ui.info(`Grid.anchor(bottom): endIdx=${endIdx} scrollTop=${Math.round(el.scrollTop)}`);
  };

  // (1) FOLLOW=true로 전환될 때:
  //  - 현재 커버리지의 바닥이 전체 tail이 아니면 마지막 페이지를 요청
  //  - 이후 바닥으로 앵커링
  useEffect(() => {
    if (!m.follow) return;
    const endIdx = m.windowStart + Math.max(0, m.rows.length) - 1;
    const atTail = m.totalRows > 0 && endIdx >= m.totalRows - 1; // 1줄 관용 오차
    if (!atTail && m.totalRows > 0) {
      const size = m.windowSize || 500;
      const tailEnd = Math.max(1, m.totalRows);
      const tailStart = Math.max(1, tailEnd - size + 1);
      ui.info(`Grid.follow: jump-to-tail request ${tailStart}-${tailEnd} (endIdx=${endIdx}, total=${m.totalRows})`);
      // 프로그램적 이동 동안 스크롤 핸들러 무시(자동 PAUSE 방지)
      ignoreScrollRef.current = true;
      lastWindowStartChangeTimeRef.current = Date.now();
      vscode?.postMessage({ v: 1, type: 'logs.page.request', payload: { startIdx: tailStart, endIdx: tailEnd } });
      requestAnimationFrame(() => { ignoreScrollRef.current = false; });
    }
    scrollToBottom();
  }, [m.follow, m.totalRows, m.windowSize, m.windowStart, m.rows.length]);

  // (2) FOLLOW=true 상태에서 새 데이터가 들어오면 → 계속 바닥으로 고정
  useEffect(() => {
    if (m.follow && m.rows.length > 0) {
      scrollToBottom();
    }
  }, [m.rows.length, m.windowStart, m.rowH, m.follow]);

  // ── 보여지는 로그 범위 로그(스로틀 + 경계 구간만) ────────────────────
  const lastVisRef = useRef<{ s: number; e: number } | null>(null);
  const emittedThresholdRef = useRef<{ p80?: boolean; p90?: boolean; end?: boolean }>({});
  useEffect(() => {
    if (virtualItems.length === 0 || !m.totalRows) return;
    const s = Math.min(...virtualItems.map(v => v.index)) + 1; // 1-based
    const e = Math.max(...virtualItems.map(v => v.index)) + 1;
    const prev = lastVisRef.current;
    const movedALot = !prev || Math.abs(s - prev.s) >= Math.max(20, Math.floor(m.windowSize / 3)) || Math.abs(e - prev.e) >= Math.max(20, Math.floor(m.windowSize / 3));

    const ratio = e / m.totalRows;
    const flags = emittedThresholdRef.current;
    const hit80 = ratio >= 0.8 && !flags.p80;
    const hit90 = ratio >= 0.9 && !flags.p90;
    const hitEnd = e >= m.totalRows && !flags.end;

    const payload = `visible=${s}-${e} items=${virtualItems.length}`;
    if ((movedALot && shouldLog('visible.range', 400)) || hit80 || hit90 || hitEnd) {
      ui.info(`Grid.visible range: ${s}-${e} (total virtualItems=${virtualItems.length})`);
      lastVisRef.current = { s, e };
      if (hit80) flags.p80 = true;
      if (hit90) flags.p90 = true;
      if (hitEnd) flags.end = true;
    }
  }, [virtualItems, m.windowSize, m.totalRows]);

  // ── 커밋 상태(렌더 완료 후 DOM/플레이스홀더 비율/needRange 추정) ─────
  useEffect(() => {
    if (!m.totalRows) return;
    // 가시구간
    const visStart = virtualItems.length ? Math.min(...virtualItems.map(v => v.index)) + 1 : 0;
    const visEnd = virtualItems.length ? Math.max(...virtualItems.map(v => v.index)) + 1 : 0;
    // 커버리지
    const bufStart = m.windowStart;
    const bufEnd = m.windowStart + Math.max(0, visibleRows.length) - 1;
    const needRange = !(visStart >= bufStart && visEnd <= bufEnd);

    // DOM 내 실제 렌더된 행 수(플레이스홀더 제외)
    let rendered = 0;
    let placeholders = 0;
    for (const v of virtualItems) {
      const offset = v.index - Math.max(0, bufStart - 1);
      const inBuf = offset >= 0 && offset < visibleRows.length;
      if (inBuf) rendered++;
      else placeholders++;
    }
    const phRatio = virtualItems.length ? Math.round((placeholders / virtualItems.length) * 100) : 0;

    const payload = `visible=${visStart}-${visEnd} coverage=${bufStart <= bufEnd ? `${bufStart}-${bufEnd}` : 'empty'} rendered=${rendered}/${virtualItems.length} placeholders=${phRatio}% needRange=${needRange}`;
    if (shouldLog('commit', 400, payload)) {
      ui.info(`Grid.commit ${payload}`);
    }
  }, [virtualItems, m.windowStart, visibleRows.length, m.totalRows]);

  // clamp: 빈번 호출이므로 로그 금지(상위 onScroll에서 결과만 출력)
  const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));

  const hi = (text: string, rules: HighlightRule[]) => {
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
  };

  const escapeHtml = (s: string) => {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  const escapeRegExp = (s: string) => {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  };

  return (
    <>
      <div
        ref={parentRef}
        className="tw-h-full tw-min-h-0 tw-overflow-y-auto tw-overflow-x-hidden tw-outline tw-outline-1 tw-outline-[var(--border)] tw-outline-offset-[-1px]"
      >
        {/* 헤더를 스크롤 컨테이너 내부로 이동 → 툴바는 고정, 헤더는 sticky */}
        <GridHeader />
        <div ref={listRef} style={{ height: totalSize, position: 'relative' }}>
          {virtualItems.map((v) => {
            // ── 가상 스크롤 인덱스 매핑 로직 ────────────────────────────────
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