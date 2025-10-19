export function bindVerticalSplitter(
  splitter: HTMLElement,
  onChange: (deltaY: number, commit: boolean) => void,
) {
  let dragging = false;
  let lastY = 0;

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const y = e.clientY;
    const delta = y - lastY;
    lastY = y;
    onChange(delta, false);
    e.preventDefault();
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try {
      splitter.releasePointerCapture(e.pointerId);
    } catch {}
    document.body.style.userSelect = '';
    splitter.classList.remove('dragging');
    onChange(0, true);
  };

  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    lastY = e.clientY;
    document.body.style.userSelect = 'none';
    splitter.classList.add('dragging');
    try {
      splitter.setPointerCapture(e.pointerId);
    } catch {}
    e.preventDefault();
  };

  splitter.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
}

/**
 * 가운데(Explorer ↔ Logs) 스플리터 바인딩 (절대 위치 기반)
 * - 첫 드래그부터 px 고정 그리드로 전환하여 "점프" 방지
 * - 컨테이너 usable 높이가 (minTop+minBottom)보다 작으면, 최소값을 비율 축소
 * - Pointer Events + setPointerCapture 로 안정적 드래그
 */
export function bindContentSplitter(
  splitter: HTMLElement,
  getSizes: () => { top: number; bottom: number; minTop: number; minBottom: number },
  setSizes: (topPx: number, bottomPx: number, commit: boolean) => void,
) {
  let dragging = false;

  // 캐시
  let contentTop = 0;
  let contentHeight = 0;
  let splitterH = 0;
  let minTop = 80;
  let minBottom = 80;

  const getContentRect = () => {
    const content = splitter.parentElement as HTMLElement; // #content
    const rect = content.getBoundingClientRect();
    const sh = splitter.getBoundingClientRect().height;
    return { top: rect.top, height: rect.height, sh };
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;

    const pointerY = e.clientY;
    // 스플리터 중앙을 기준으로 상단 px 계산
    let topPx = pointerY - contentTop - splitterH / 2;

    // 사용가능 높이(스플리터 제외)
    const usable = Math.max(0, contentHeight - splitterH);

    // 제약(최소/최대)
    const maxTop = Math.max(minTop, usable - minBottom);
    topPx = Math.min(Math.max(topPx, minTop), maxTop);

    const bottomPx = usable - topPx;
    setSizes(topPx, bottomPx, false);

    e.preventDefault();
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try {
      splitter.releasePointerCapture(e.pointerId);
    } catch {}
    document.body.style.userSelect = '';
    splitter.classList.remove('dragging');

    // 커밋 시점 보정
    const { top, bottom } = getSizes();
    setSizes(Math.max(top, minTop), Math.max(bottom, minBottom), true);
  };

  const onPointerDown = (e: PointerEvent) => {
    const sz = getSizes();
    minTop = sz.minTop;
    minBottom = sz.minBottom;

    const rect = getContentRect();
    contentTop = rect.top;
    contentHeight = rect.height;
    splitterH = rect.sh;

    // usable 공간이 최소합보다 작으면, 최소값을 비율로 축소
    const usable = Math.max(0, contentHeight - splitterH);
    const minSum = minTop + minBottom;
    if (usable < minSum && minSum > 0) {
      const s = usable / minSum;
      minTop = Math.max(0, Math.floor(minTop * s));
      minBottom = Math.max(0, Math.floor(minBottom * s));
    }

    // 첫 프레임부터 현재 레이아웃을 px로 고정(점프 제거)
    setSizes(sz.top, sz.bottom, false);

    dragging = true;
    document.body.style.userSelect = 'none';
    splitter.classList.add('dragging');
    try {
      splitter.setPointerCapture(e.pointerId);
    } catch {}
    e.preventDefault();
  };

  splitter.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
}
