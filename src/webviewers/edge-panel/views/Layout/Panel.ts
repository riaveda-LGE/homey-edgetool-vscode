export function ensureExplorerContainer(root: HTMLElement) {
  let el = document.getElementById('explorer') as HTMLElement | null;
  if (!el) {
    el = document.createElement('section');
    el.id = 'explorer';
    el.setAttribute('aria-label', 'explorer');
    // 내부 마크업은 ExplorerView 가 책임지고 렌더한다.
    root.appendChild(el);
  }
  return el;
}

export function ensureContentSplitter(root: HTMLElement) {
  let el = document.getElementById('contentSplitter') as HTMLElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = 'contentSplitter';
    el.className = 'content-splitter';
    root.appendChild(el);
  }
  return el;
}
