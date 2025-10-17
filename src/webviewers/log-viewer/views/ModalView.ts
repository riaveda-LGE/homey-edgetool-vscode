// === src/webviewers/log-viewer/views/ModalView.ts ===
/**
 * 간단한 모달 렌더러.
 * AppView.ts에서: import { renderModal } from './ModalView'
 * 외부 타입 의존성 없이 export 만 제공 (경고/에러 해결 목적)
 */

export type ModalOptions = {
  title?: string;
  content?: string | HTMLElement;
  onClose?: () => void;
};

export function renderModal(opts: ModalOptions) {
  const root = document.createElement('div');
  root.className = 'lv-modal-root';

  const backdrop = document.createElement('div');
  backdrop.className = 'lv-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'lv-modal';

  const header = document.createElement('div');
  header.className = 'lv-modal-header';
  header.textContent = opts.title ?? '설정';

  const body = document.createElement('div');
  body.className = 'lv-modal-body';
  if (typeof opts.content === 'string') {
    body.innerHTML = opts.content;
  } else if (opts.content instanceof HTMLElement) {
    body.appendChild(opts.content);
  }

  const footer = document.createElement('div');
  footer.className = 'lv-modal-footer';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn';
  closeBtn.textContent = '닫기';
  closeBtn.addEventListener('click', () => {
    try { document.body.removeChild(root); } catch {}
    opts.onClose?.();
  });

  footer.appendChild(closeBtn);
  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);

  root.appendChild(backdrop);
  root.appendChild(modal);
  document.body.appendChild(root);

  return {
    close: () => {
      try { document.body.removeChild(root); } catch {}
      opts.onClose?.();
    },
  };
}
