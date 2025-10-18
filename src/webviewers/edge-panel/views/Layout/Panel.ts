export function ensureExplorerContainer(root: HTMLElement) {
  let el = document.getElementById('explorer') as HTMLElement | null;
  if (!el) {
    el = document.createElement('section');
    el.id = 'explorer';
    el.setAttribute('aria-label', 'explorer');
    el.innerHTML = `
      <div id="explorerBar">
        <div id="explorerTitle">Explorer</div>
        <div id="explorerActions" aria-label="explorer actions">
          <button id="explorerRefresh" title="Refresh (F5)" aria-label="Refresh"></button>
          <span id="explorerBusy" aria-hidden="true"></span>
        </div>
        <div id="explorerPath"></div>
      </div>
      <div id="explorerTree" role="tree" tabindex="0"></div>
    `;
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
