import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';

import { createUiMeasure } from '../../../shared/utils';
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
  const measureUi = useLogStore((s) => s.measureUi);
  const m = useLogStore();
  const [preview, setPreview] = useState({ open: false, logRow: null as LogRow | null });
  // grid 전용 ui logger
  const ui = useMemo(() => createUiLog(vscode, 'log-viewer.grid'), []);

  // 동일 요청 범위 중복 송신 방지 (훅은 반드시 최상위에서 선언)
  const lastReqRef = useRef<{ s: number; e: number } | null>(null);
  // 빠른 스크롤의 과요청을 줄이기 위한 요청 스케줄러
  const debounceTimerRef = useRef<number | null>(null);
  const maxWaitTimerRef = useRef<number | null>(null);
  const pendingReqRef = useRef<{ s: number; e: number; payload: string } | null>(null);
  // 기본(debounce) / 드래그 추정 시 확장 / 드래그 중에도 너무 오래 비우지 않기 위한 주기
  // BASE_DEBOUNCE_MS ≤ DRAG_DEBOUNCE_MS ≤ MAX_WAIT_MS 관계 필수
  const BASE_DEBOUNCE_MS = 48; // 하나의 휠 burst를 잘 묶는 값(≈ 3프레임)
  const DRAG_DEBOUNCE_MS = 80;
  const MAX_WAIT_MS = 240;
  // 스크롤 속도로 "드래그 추정"을 한다(행/초 기준). 빠르면 일정 시간 동안 드래그 상태로 간주.
  const DRAG_RPS_THRESHOLD = 120; // rows per second
  const DRAG_IDLE_MS = 140; // DRAG여부를 판단하는 변수. 해당값 이내에 DRAG가 발생해야 계속 DRAG로 판단.고속 스크롤 뒤 이 시간 동안 이벤트 없으면 드래그 종료.
  const lastScrollSampleRef = useRef<{ top: number; t: number } | null>(null);
  const dragActiveUntilRef = useRef(0);

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

  const flushScheduledRequest = (reason: string) => {
    const p = pendingReqRef.current;
    if (!p) return;
    pendingReqRef.current = null;
    // 동일 범위 중복 요청 방지
    if (lastReqRef.current && lastReqRef.current.s === p.s && lastReqRef.current.e === p.e) return;
    lastReqRef.current = { s: p.s, e: p.e };
    if (shouldLog('page.request', 200, p.payload)) {
      ui.debug?.(`Grid.scroll → page.request (flush:${reason}) ${p.payload}`);
    }
    measureUi('Grid.page.request', () =>
      vscode?.postMessage({
        v: 1,
        type: 'logs.page.request',
        payload: { startIdx: p.s, endIdx: p.e },
      }),
    );
    // 한 번 보냈으면 타이머들은 정리
    if (debounceTimerRef.current) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (maxWaitTimerRef.current) {
      window.clearTimeout(maxWaitTimerRef.current);
      maxWaitTimerRef.current = null;
    }
  };

  const schedulePageRequest = (
    startIdx: number,
    endIdx: number,
    payload: string,
    opts?: { delayMs?: number; isDragging?: boolean },
  ) => {
    // pending이 같으면 무시
    if (
      pendingReqRef.current &&
      pendingReqRef.current.s === startIdx &&
      pendingReqRef.current.e === endIdx
    )
      return;
    pendingReqRef.current = { s: startIdx, e: endIdx, payload };
    if (debounceTimerRef.current) window.clearTimeout(debounceTimerRef.current);
    const delay = Math.max(0, opts?.delayMs ?? BASE_DEBOUNCE_MS);
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      flushScheduledRequest('debounce');
    }, delay);

    // 드래그 중에는 너무 오래 비우지 않도록 max-wait 보장(예: 240ms마다 1회)
    if (opts?.isDragging) {
      if (maxWaitTimerRef.current) window.clearTimeout(maxWaitTimerRef.current);
      maxWaitTimerRef.current = window.setTimeout(() => {
        maxWaitTimerRef.current = null;
        flushScheduledRequest('max-wait');
      }, MAX_WAIT_MS);
    } else {
      if (maxWaitTimerRef.current) {
        window.clearTimeout(maxWaitTimerRef.current);
        maxWaitTimerRef.current = null;
      }
    }
  };

  // 더블클릭 → Dialog 오픈 시 잔여 click 이벤트가 먼저 발생하지 않도록 약간 지연
  const DIALOG_OPEN_DELAY_MS = 40;
  const openPreview = (row: LogRow) => {
    measureUi('Grid.openPreview', () => ui.debug?.('[debug] Grid: openPreview start'));
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
    measureUi('Grid.mount', () =>
      ui.info(`Grid.mount totalRows=${m.totalRows} windowStart=${m.windowStart}`),
    );
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
      measureUi('Grid.unmount', () => ui.info('Grid.unmount'));
      ro?.disconnect();
      if (debounceTimerRef.current) window.clearTimeout(debounceTimerRef.current);
      if (maxWaitTimerRef.current) window.clearTimeout(maxWaitTimerRef.current);
    };
  }, []);

  // Host 페이지 요청 (가상 스크롤 이동시)
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    const onScroll = () => {
      // 프로그램적 스크롤 보정 중에는 요청 차단
      if (ignoreScrollRef.current || Date.now() - lastWindowStartChangeTimeRef.current < 100)
        return;

      const cur = parentRef.current;
      if (!cur) return;

      const headerOffset = listRef.current?.offsetTop ?? 0;
      const viewportH = Math.max(0, (cur.clientHeight || 0) - headerOffset);
      const estStart =
        Math.floor(Math.max(0, cur.scrollTop - headerOffset) / Math.max(1, m.rowH)) + 1;

      // ⚠️ 헤더 높이를 제외한 가시 영역 높이로 용량(capacity) 계산
      const capacity = Math.max(1, Math.floor(viewportH / Math.max(1, Math.round(m.rowH))));
      // 요청 폭을 뷰포트 용량 + overscan 으로 확장하되, windowSize 를 넘지 않도록 제한
      const requestSize = Math.max(capacity, Math.min(m.windowSize, capacity + m.overscan));
      // 스크롤 시작점의 상한선은 "요청 폭" 기준으로 계산해야 하단에서 빈칸이 줄어듦
      const maxStart = Math.max(1, m.totalRows - requestSize + 1);

      const halfOver = Math.floor(m.overscan / 2);
      const desiredStartRaw = estStart - halfOver;
      const desiredStart = Math.min(Math.max(1, desiredStartRaw), maxStart);

      // 방향성에 따른 임계치: 아래로(앞으로) 작은 이동은 생략, 위로(이전 구간 프리페치) 작은 이동은 허용
      const diff = desiredStart - m.windowStart;
      const smallMove = Math.abs(diff) < Math.max(10, halfOver);
      if (smallMove && diff >= 0) return;

      const startIdx = desiredStart;
      const endIdx = Math.min(m.totalRows, startIdx + requestSize - 1);

      // --- 드래그 추정(속도 기반) ------------------------------------------
      const now = performance.now();
      const last = lastScrollSampleRef.current;
      if (last) {
        const dt = Math.max(1, now - last.t);
        const dy = Math.abs(cur.scrollTop - last.top);
        const rowsPerSec = dy / Math.max(1, m.rowH) / (dt / 1000);
        // 고속이면 일정 시간 동안 드래그 상태 유지
        if (rowsPerSec >= DRAG_RPS_THRESHOLD) {
          dragActiveUntilRef.current = now + DRAG_IDLE_MS;
        }
      }
      lastScrollSampleRef.current = { top: cur.scrollTop, t: now };
      const isDragging = now < dragActiveUntilRef.current;
      const delayMs = isDragging ? DRAG_DEBOUNCE_MS : BASE_DEBOUNCE_MS;

      const payload = `start=${startIdx} end=${endIdx} estStart=${estStart} cap=${capacity} req=${requestSize} maxStart=${maxStart} windowStart=${m.windowStart} dragging=${isDragging}`;
      // 빠른 스크롤(드래그)일수록 요청을 더 묶고, 정지 시 마지막 범위를 보냄
      schedulePageRequest(startIdx, endIdx, payload, { delayMs, isDragging });

      // ✅ FOLLOW 자동 해제: 사용자가 바닥 근처를 벗어나면 PAUSE로 전환
      const nearBottom =
        cur.scrollTop + cur.clientHeight >=
        cur.scrollHeight - m.rowH * (AUTO_PAUSE_TOLERANCE_ROWS + 0.5);
      if (m.follow && !nearBottom) {
        measureUi('Grid.setFollow', () => useLogStore.getState().setFollow(false));
        ui.info('Grid.scroll: auto-pause follow (scrolled away from bottom)');
      }
    };

    el.addEventListener('scroll', onScroll, { passive: true } as AddEventListenerOptions);
    return () => el.removeEventListener('scroll', onScroll as unknown as EventListener);
  }, [m.rowH, m.windowStart, m.totalRows, m.overscan, m.windowSize, m.follow]);

  // 프리뷰 상태 변경 로그
  useEffect(() => {
    measureUi('Grid.preview.state', () =>
      ui.info(`Grid.preview state open=${preview.open} rowId=${preview.logRow?.id ?? 'none'}`),
    );
  }, [preview.open, preview.logRow?.id]);

  // 마지막 보이는 컬럼이 항상 1fr이 되도록 그리드 트랙을 구성
  const gridCols = useMemo(() => {
    measureUi('Grid.buildGridTemplate', () => ui.debug?.('[debug] Grid: buildGridTemplate start'));
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
    measureUi('Grid.buildGridTemplate.end', () =>
      ui.debug?.('[debug] Grid: buildGridTemplate end'),
    );
    // 북마크 고정폭 열 + 인덱스 고정폭 열 + 본문 컬럼들
    return `var(--col-bm-w) var(--col-idx-w) ${tracks.join(' ')}`;
  }, [
    m.showCols.time,
    m.showCols.proc,
    m.showCols.pid,
    m.showCols.src,
    m.showCols.msg,
    m.colW.time,
    m.colW.proc,
    m.colW.pid,
    m.colW.src,
  ]);
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

  // 인덱스 열 너비(총행수 자릿수 기반): 최소 48px, 최대 120px
  const idxWidthPx = useMemo(() => {
    const digits = Math.max(2, String(Math.max(1, m.totalRows || 0)).length);
    return Math.min(120, Math.max(48, 14 + digits * 8)); // pad + digit*8px
  }, [m.totalRows]);

  // ── 인덱스 점프 처리(북마크/검색 등) ────────────────────────────────
  useEffect(() => {
    const idx = m.pendingJumpIdx;
    if (!idx || !parentRef.current) return;
    const el = parentRef.current;
    const headerOffset = listRef.current?.offsetTop ?? 0;
    const viewportH = Math.max(0, el.clientHeight - headerOffset);
    const rowH = Math.max(1, Math.round(m.rowH));
    const cap = Math.max(1, Math.floor(viewportH / rowH));
    // "중앙" 산정: 화면에 보이는 행수(cap)의 가운데
    const centerOffset = Math.floor((cap - 1) / 2); // 중앙 위쪽에 놓일 행 수
    const centerTopIdx = 1 + centerOffset; // 스크롤 top일 때 중앙에 오는 전역 idx
    const centerBottomIdx = Math.max(1, m.totalRows - cap + 1 + centerOffset); // 스크롤 bottom일 때 중앙에 오는 전역 idx

    // 규칙:
    // idx < centerTopIdx     → top 앵커
    // idx > centerBottomIdx  → bottom 앵커
    // 그 외                   → 중앙 정렬
    let mode: 'top' | 'center' | 'bottom';
    if (idx < centerTopIdx) mode = 'top';
    else if (idx > centerBottomIdx) mode = 'bottom';
    else mode = 'center';

    // 화면 스크롤 위치 계산
    let targetScrollTop: number;
    if (mode === 'top') {
      targetScrollTop = headerOffset; // 헤더 바로 아래가 리스트 시작점
    } else if (mode === 'bottom') {
      targetScrollTop = headerOffset + m.totalRows * rowH - el.clientHeight;
    } else {
      const startForView = Math.max(
        1,
        Math.min(Math.max(1, m.totalRows - cap + 1), idx - centerOffset),
      );
      targetScrollTop = headerOffset + (startForView - 1) * rowH;
    }

    // 요청 범위(버퍼)는 기존처럼 windowSize 중심으로 확보
    const half = Math.floor(m.windowSize / 2);
    const reqStart = Math.max(1, Math.min(Math.max(1, m.totalRows - m.windowSize + 1), idx - half));
    const reqEnd = Math.min(m.totalRows, reqStart + m.windowSize - 1);

    measureUi('Grid.jumpToIdx', () =>
      ui.info(
        `Grid.jumpToIdx idx=${idx} cap=${cap} centerTop=${centerTopIdx} centerBottom=${centerBottomIdx} mode=${mode} → request ${reqStart}-${reqEnd}`,
      ),
    );

    // 점프 시에만 프로그램적 스크롤 적용(+ onScroll 무시)
    ignoreScrollRef.current = true;
    lastWindowStartChangeTimeRef.current = Date.now();
    el.scrollTop = Math.max(0, Math.min(targetScrollTop, el.scrollHeight - el.clientHeight));
    // 다음 프레임에서 해제
    requestAnimationFrame(() => {
      ignoreScrollRef.current = false;
    });
    measureUi('Grid.page.request.jump', () =>
      vscode?.postMessage({
        v: 1,
        type: 'logs.page.request',
        payload: { startIdx: reqStart, endIdx: reqEnd },
      }),
    );
  }, [m.pendingJumpIdx, m.windowSize, m.totalRows, m.rowH]);

  // pendingJumpIdx가 뷰포트로 로드되면 해당 행을 선택 상태로 확정
  useEffect(() => {
    const target = m.pendingJumpIdx;
    if (!target) return;
    const found = m.rows.find((r) => r.idx === target);
    if (found) {
      measureUi('Grid.jump.resolve', () =>
        ui.info(`Grid.jump.resolve idx=${target} → rowId=${found.id}`),
      );
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
      measureUi('Grid.coverage', () =>
        ui.info(`Grid.coverage loaded=${cov} len=${visibleRows.length}/${m.windowSize}`),
      );
      lastCoverageRef.current = cov;
    }
  }, [m.windowStart, visibleRows.length, m.windowSize, m.totalRows]);

  // ── 공통: 맨 아래로 앵커링 함수 ──────────────────────────────────────
  const scrollToBottom = () => {
    const el = parentRef.current;
    const list = listRef.current;
    if (!el || !list) return;
    const headerOffset = list.offsetTop || 0;
    // ⚠️ 리프레시 직후 rows가 비어 있을 수 있다.
    //    이 때 endIdx=0 앵커가 발생해 상단으로 튀는 현상을 방지한다.
    const hasRows = (m.rows?.length ?? 0) > 0;
    // rows가 비어있으면, 현재 총 행수 기준으로 하단을 계산한다(유효 totalRows가 없으면 앵커 생략).
    const fallbackEndIdx = Math.max(1, m.totalRows || 0);
    const endIdx = hasRows ? m.windowStart + m.rows.length - 1 : fallbackEndIdx;
    if (!hasRows && endIdx <= 0) {
      // 총행수도 모르거나 0이면 아직 앵커링하지 않는다.
      return;
    }
    const target = headerOffset + endIdx * Math.max(1, m.rowH) - el.clientHeight;
    ignoreScrollRef.current = true;
    lastWindowStartChangeTimeRef.current = Date.now();
    el.scrollTop = Math.max(0, Math.min(target, el.scrollHeight - el.clientHeight));
    requestAnimationFrame(() => {
      ignoreScrollRef.current = false;
    });
    measureUi('Grid.anchor', () =>
      ui.info(`Grid.anchor(bottom): endIdx=${endIdx} scrollTop=${Math.round(el.scrollTop)}`),
    );
  };

  // ── 리프레시 직후 빈 화면 완화: totalRows만 갱신되고 rows는 비어있을 때, 즉시 테일 구간 요청 ──
  useEffect(() => {
    // 조건:
    //  - 총행수(totalRows)는 존재
    //  - 현재 로우는 비어 있음(리프레시 직후 과도기)
    //  - 바닥 팔로우가 켜져 있거나(보통 기본) 최초 앵커링 전
    if (
      (m.totalRows ?? 0) > 0 &&
      (m.rows?.length ?? 0) === 0 &&
      (m.follow || !initialAnchoredRef.current)
    ) {
      const endIdx = Math.max(1, m.totalRows);
      const startIdx = Math.max(1, endIdx - m.windowSize + 1);
      const payload = `refresh:auto start=${startIdx} end=${endIdx} total=${m.totalRows}`;
      // 리프레시 직후엔 스크롤 속도가 없으므로 기본 딜레이로 즉시 요청
      schedulePageRequest(startIdx, endIdx, payload, {
        delayMs: BASE_DEBOUNCE_MS,
        isDragging: false,
      });
    }
  }, [m.totalRows, m.rows?.length, m.follow, m.windowSize]);

  // (1) FOLLOW=true일 때 바닥으로 앵커링:
  //  - 현재 커버리지의 바닥이 전체 tail이 아니면 마지막 페이지를 요청
  //  - 이후 바닥으로 앵커링
  useEffect(() => {
    // 명시적 점프(검색/북마크) 진행 중에는 tail로 강제 이동하지 않는다.
    if (!m.follow || m.pendingJumpIdx) return;
    const endIdx = m.windowStart + Math.max(0, m.rows.length) - 1;
    const atTail = m.totalRows > 0 && endIdx >= m.totalRows - 1; // 1줄 관용 오차
    if (!atTail && m.totalRows > 0) {
      const size = m.windowSize || 500;
      const tailEnd = Math.max(1, m.totalRows);
      const tailStart = Math.max(1, tailEnd - size + 1);
      measureUi('Grid.follow.jump', () =>
        ui.info(
          `Grid.follow: jump-to-tail request ${tailStart}-${tailEnd} (endIdx=${endIdx}, total=${m.totalRows})`,
        ),
      );
      // 프로그램적 이동 동안 스크롤 핸들러 무시(자동 PAUSE 방지)
      ignoreScrollRef.current = true;
      lastWindowStartChangeTimeRef.current = Date.now();
      measureUi('Grid.page.request.follow', () =>
        vscode?.postMessage({
          v: 1,
          type: 'logs.page.request',
          payload: { startIdx: tailStart, endIdx: tailEnd },
        }),
      );
      requestAnimationFrame(() => {
        ignoreScrollRef.current = false;
      });
    }
    scrollToBottom();
  }, [m.follow, m.pendingJumpIdx, m.totalRows, m.windowSize, m.windowStart, m.rows.length]);

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
    const s = Math.min(...virtualItems.map((v) => v.index)) + 1; // 1-based
    const e = Math.max(...virtualItems.map((v) => v.index)) + 1;
    const prev = lastVisRef.current;
    const movedALot =
      !prev ||
      Math.abs(s - prev.s) >= Math.max(20, Math.floor(m.windowSize / 3)) ||
      Math.abs(e - prev.e) >= Math.max(20, Math.floor(m.windowSize / 3));

    const ratio = e / m.totalRows;
    const flags = emittedThresholdRef.current;
    const hit80 = ratio >= 0.8 && !flags.p80;
    const hit90 = ratio >= 0.9 && !flags.p90;
    const hitEnd = e >= m.totalRows && !flags.end;

    const payload = `visible=${s}-${e} items=${virtualItems.length}`;
    if ((movedALot && shouldLog('visible.range', 400)) || hit80 || hit90 || hitEnd) {
      measureUi('Grid.visible.range', () =>
        ui.info(`Grid.visible range: ${s}-${e} (total virtualItems=${virtualItems.length})`),
      );
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
    const visStart = virtualItems.length ? Math.min(...virtualItems.map((v) => v.index)) + 1 : 0;
    const visEnd = virtualItems.length ? Math.max(...virtualItems.map((v) => v.index)) + 1 : 0;
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
    const phRatio = virtualItems.length
      ? Math.round((placeholders / virtualItems.length) * 100)
      : 0;

    const payload = `visible=${visStart}-${visEnd} coverage=${bufStart <= bufEnd ? `${bufStart}-${bufEnd}` : 'empty'} rendered=${rendered}/${virtualItems.length} placeholders=${phRatio}% needRange=${needRange}`;
    if (shouldLog('commit', 400, payload)) {
      measureUi('Grid.commit', () => ui.info(`Grid.commit ${payload}`));
    }

    // ── PROBE: 논리 페인트 순서 & DOM 순서 ────────────────────────────
    try {
      const bufferStart0 = Math.max(0, m.windowStart - 1);
      const logical = virtualItems
        .map((v) => {
          const offset = v.index - bufferStart0;
          const r = offset >= 0 && offset < visibleRows.length ? visibleRows[offset] : undefined;
          return typeof r?.idx === 'number' ? r.idx : undefined;
        })
        .filter((x): x is number => typeof x === 'number');
      if (logical.length) {
        const asc = logical.every((x, i, a) => i === 0 || a[i - 1] <= x);
        const head = logical.slice(0, 6).join(',');
        const tail = logical.slice(-6).join(',');
        const probePayload = `asc=${asc} h=${head} t=${tail}`;
        if (shouldLog('probe.grid.paint', 400, probePayload)) {
          measureUi('Grid.probe.paint', () =>
            ui.info(`[probe:grid] paint logical asc=${asc} head=[${head}] tail=[${tail}]`),
          );
        }
      }
      const cont = listRef.current;
      if (cont) {
        const nodes = Array.from(cont.querySelectorAll('[data-vidx]')).slice(0, 8);
        const domSeq = nodes.map((n) => (n as HTMLElement).dataset['vidx']).join(',');
        if (shouldLog('probe.grid.dom', 400, domSeq)) {
          measureUi('Grid.probe.dom', () => ui.info(`[probe:grid] DOM order first8=[${domSeq}]`));
        }
      }
    } catch {}
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
        <div ref={listRef} data-grid-root style={{ height: totalSize, position: 'relative' }}>
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
                data-vidx={r.idx}
                className={[
                  'tw-grid',
                  r.bookmarked
                    ? 'tw-bg-[color-mix(in_oklab,var(--row-selected)_20%,transparent_80%)]'
                    : '',
                  isSelected
                    ? 'tw-bg-[var(--row-focus)] tw-shadow-[inset_0_0_0_1px_var(--row-focus-border)]'
                    : '',
                ].join(' ')}
                // 행 컨테이너: 인덱스 고정폭 변수를 함께 주입
                style={{
                  position: 'absolute',
                  top: v.start,
                  left: 0,
                  right: 0,
                  height: v.size,
                  gridTemplateColumns: gridCols,
                  columnGap: anyHidden ? 0 : undefined,
                  // CSS Custom Property 주입
                  ['--col-idx-w' as any]: `${idxWidthPx}px`,
                }}
                onClick={() => useLogStore.getState().jumpToRow(r.id, r.idx)}
                aria-selected={isSelected || undefined}
                /* 행 어디를 더블클릭해도 팝업이 뜨도록 보장 */
                onDoubleClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  measureUi('Grid.row.dblclick', () =>
                    ui.info(
                      `Grid.row.dblclick id=${r.id} time="${r.time}" len=${r.raw?.length ?? r.msg.length} curOpen=${preview.open}`,
                    ),
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
                      if (typeof r.idx !== 'number') return; // 방어
                      // NOTE: TS의 타입 내로잉은 중첩 콜백 경계를 넘지 않는다.
                      //       measureUi 콜백 내부에서도 number로 보장되도록 별도 변수로 고정한다.
                      const idx = r.idx;
                      measureUi('Grid.toggleBookmarkByIdx', () =>
                        useLogStore.getState().toggleBookmarkByIdx(idx),
                      );
                    }}
                  />
                </div>
                {/* ── 인덱스 고정폭 열(항상 보임) ─────────────────────────── */}
                <Cell kind="idx" mono align="right">
                  {typeof r.idx === 'number' ? r.idx : ''}
                </Cell>
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
  kind: 'idx' | 'time' | 'proc' | 'pid' | 'src' | 'msg';
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
