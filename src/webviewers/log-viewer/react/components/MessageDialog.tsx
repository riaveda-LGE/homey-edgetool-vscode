import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LogRow } from '../types';
import { vscode } from '../ipc';
import { createUiLog } from '../../../shared/utils';

interface MessageDialogProps {
  isOpen: boolean;
  onClose: () => void;
  logRow: LogRow | null;
}

export function MessageDialog({ isOpen, onClose, logRow }: MessageDialogProps) {
  const [copied, setCopied] = useState(false);
  const ui = useMemo(() => createUiLog(vscode, 'log-viewer.dialog'), []);
  // 열림 직후 잔여 click이 백드롭으로 들어와 닫히는 현상을 방지
  const IGNORE_BACKDROP_MS = 220;
  const [openedAt, setOpenedAt] = useState(null);
  // 훅 순서 고정: 조기 return 금지하고 open 플래그로만 제어
  const open = !!isOpen && !!logRow;
  const closeBtnRef = useRef(null);
  const panelRef = useRef(null);
  // ── 드래그 이동 상태 ─────────────────────────────────────────
  const [pos, setPos] = useState({ x: 0, y: 0 }); // 중앙 기준 translate
  const dragState = useRef({
    active: false, startX: 0, startY: 0, baseX: 0, baseY: 0
  });

  // 열림/대상행 변경 감시
  useEffect(()=>{
    ui.info(`Dialog.state isOpen=${isOpen} rowId=${logRow?.id ?? 'none'} open=${open}`);
    if (open) {
      const now = Date.now();
      setOpenedAt(now);
      ui.info(`Dialog.opened at=${now} ignoreBackdropFor=${IGNORE_BACKDROP_MS}ms`);
      // 오픈 시 위치 초기화(중앙에서 시작)
      setPos({ x: 0, y: 0 });
    } else {
      setOpenedAt(null);
    }
  }, [isOpen, logRow?.id, open]);

  // 렌더 사이클 추적(보이면 언제든 찍힘)
  useEffect(() => {
    ui.debug?.(`Dialog.render open=${open} rowId=${logRow?.id ?? 'none'}`);
  }, [open, logRow?.id]);

  // (승격 버전) 오프스크린 측정/뷰포트 추적, fallbackMode는 더 이상 사용하지 않습니다.

  const handleCopy = async () => {
    if (!logRow) return;
    const textToCopy =
      logRow.raw ??
      `[${logRow.time}] ${logRow.proc}[${logRow.pid}]: ${logRow.msg}`;

    try {
      ui.info(`Dialog.copy click rowId=${logRow.id} textLen=${textToCopy.length}`);
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      ui.info('Dialog.copy success');
    } catch (err) {
      ui.error(`Dialog.copy fail: ${String(err)}`);
    }
  };

  const handleClose = () => {
    ui.info('Dialog.onClose');
    onClose();
  };

  // Esc로만 닫히게: 바깥 클릭은 완전히 무시
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!open) return;
      if (ev.key === 'Escape') {
        const now = Date.now();
        const elapsed = openedAt ? now - openedAt : Number.POSITIVE_INFINITY;
        if (elapsed < IGNORE_BACKDROP_MS) {
          ui.info(`Dialog.keydown Escape IGNORED elapsed=${elapsed}ms (<${IGNORE_BACKDROP_MS})`);
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        ui.info('Dialog.keydown Escape CLOSE');
        handleClose();
      } else {
        ui.debug?.(`Dialog.keydown key=${ev.key}`);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, openedAt]);

  // ── 포커스 트랩: Tab 순환으로 모달 내에 가두기 ───────────────────────
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;
    const onTab = (ev: KeyboardEvent) => {
      if (ev.key !== 'Tab') return;
      if (ev.shiftKey) {
        if (document.activeElement === first) {
          ev.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          ev.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onTab);
    return () => window.removeEventListener('keydown', onTab);
  }, [open]);

  // ── 드래그 구현: 타이틀바에서 포인터 트래킹 ────────────────
  const onDragStart = (e: React.PointerEvent) => {
    dragState.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      baseX: pos.x,
      baseY: pos.y,
    };
    (e.target as Element).setPointerCapture?.(e.pointerId);
    ui.debug?.(`Dialog.drag.start x=${e.clientX} y=${e.clientY} base=(${pos.x},${pos.y})`);
  };
  const onDragMove = (e: React.PointerEvent) => {
    if (!dragState.current.active) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    setPos({ x: dragState.current.baseX + dx, y: dragState.current.baseY + dy });
  };
  const onDragEnd = (e: React.PointerEvent) => {
    if (!dragState.current.active) return;
    dragState.current.active = false;
    ui.debug?.(`Dialog.drag.end at=(${pos.x},${pos.y})`);
  };

  // ── 기본 React 모달 렌더링 ───────────────────────────────────────────
  if (!open) return null;

  return createPortal(
    <div
      data-dialog="log-message"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483647,
        background: 'rgba(0,0,0,0.40)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
      onMouseDown={(e) => { e.stopPropagation(); }} // outside click 무시(닫지 않음)
      onClick={(e) => { e.stopPropagation(); }}
    >
      <div
        ref={panelRef}
        style={{
          width: '100%',
          maxWidth: '64rem',
          background: 'var(--panel)',
          color: 'var(--fg)',
          border: '1px solid var(--border)',
          borderRadius: '1rem',
          boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
          overflow: 'hidden',
          /* 중앙 기준으로 드래그 이동 (항상 적용) */
          transform: `translate(${pos.x}px, ${pos.y}px)`,
        }}
        onMouseDown={(e) => { e.stopPropagation(); }}
        onClick={(e) => { e.stopPropagation(); }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.75rem 1rem',
            borderBottom: '1px solid var(--border)',
            cursor: 'move',
            userSelect: dragState.current.active ? 'none' : undefined,
          }}
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        >
          <div style={{ fontSize: 14 }}>로그</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleCopy}
              style={{
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 6,
                background: 'var(--accent)',
                color: 'var(--accent-fg)',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {copied ? '복사됨' : '복사'}
            </button>
            <button
              ref={closeBtnRef}
              onClick={handleClose}
              style={{
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
              }}
            >
              닫기
            </button>
          </div>
        </div>
        <div style={{ maxHeight: '70vh', overflow: 'auto', padding: '1rem' }}>
          <pre style={{
            margin: 0,
            fontSize: 13,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: 'var(--bg)',
            color: 'var(--fg)',
            padding: '0.75rem',
            borderRadius: 8,
            border: '1px solid var(--border)'
          }}>
            {logRow ? (logRow.raw ?? `[${logRow.time}] ${logRow.proc}[${logRow.pid}]: ${logRow.msg}`) : '로그 데이터를 불러올 수 없습니다.'}
          </pre>
        </div>
      </div>
    </div>,
    document.body
  );
}
