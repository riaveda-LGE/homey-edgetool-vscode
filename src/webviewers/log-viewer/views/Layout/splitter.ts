// src/webviewers/log-viewer/lib/splitter.ts
// Log Viewer 전용 수직/수평 스플리터 유틸
// - VS Code CSP 안전: Pointer Events + setPointerCapture
// - log-viewer의 톱/바텀 분리바(수직), 북마크 사이드 분리바(수평) 요구에 맞춘 얇은 API

export type BindVerticalArgs = {
  el: HTMLElement;
  onDelta: (dy: number, commit: boolean) => void;
};

export function bindVerticalSplitter({ el, onDelta }: BindVerticalArgs) {
  let dragging = false;
  let lastY = 0;

  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dy = e.clientY - lastY;
    lastY = e.clientY;
    onDelta(dy, false);
    e.preventDefault();
  };

  const onUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try { el.releasePointerCapture(e.pointerId); } catch {}
    document.body.style.userSelect = '';
    el.classList.remove('dragging');
    onDelta(0, true);
  };

  const onDown = (e: PointerEvent) => {
    dragging = true;
    lastY = e.clientY;
    document.body.style.userSelect = 'none';
    el.classList.add('dragging');
    try { el.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  };

  el.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
}

/** 수평(좌우) 분리바—북마크 패널 폭 조절 등에 사용 */
export type BindHorizontalArgs = {
  el: HTMLElement;
  onDelta: (dx: number, commit: boolean) => void;
};

export function bindHorizontalSplitter({ el, onDelta }: BindHorizontalArgs) {
  let dragging = false;
  let lastX = 0;

  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    onDelta(dx, false);
    e.preventDefault();
  };

  const onUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try { el.releasePointerCapture(e.pointerId); } catch {}
    document.body.style.userSelect = '';
    el.classList.remove('dragging');
    onDelta(0, true);
  };

  const onDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    document.body.style.userSelect = 'none';
    el.classList.add('dragging');
    try { el.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  };

  el.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
}

/** CSS 변수 숫자 읽기(루트/엘리먼트 공용) */
export const cssNum = (elOrRoot: Element, name: string) =>
  Number(getComputedStyle(elOrRoot).getPropertyValue(name).replace(/[^\d.]/g, '')) || 0;
