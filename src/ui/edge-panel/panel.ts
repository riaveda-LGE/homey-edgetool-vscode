// === src/ui/edge-panel/panel.ts ===
(function () {
  const vscode = acquireVsCodeApi();

  // lightweight logger
  const log = (...a: any[]) => console.log('[edge-panel]', ...a);

  // ── DOM refs (null-safe) ─────────────────────────────────────
  const rootEl = document.getElementById('root') as HTMLElement | null;
  const controlsEl = document.getElementById('controls') as HTMLElement | null;
  const sectionsEl = document.getElementById('sections') as HTMLElement | null;

  const splitter = document.getElementById('splitter') as HTMLElement | null;
  const logsEl = document.getElementById('logs') as HTMLElement | null;
  const cmdbarEl = document.getElementById('cmdbar') as HTMLElement | null;
  const inputEl = document.getElementById('input') as HTMLInputElement | null;
  const runBtn = document.getElementById('runBtn') as HTMLButtonElement | null;

  // explorer 영역은 필요 시 동적 생성(로그 컨테이너(#logs) 안에 붙임)
  let explorerEl = document.getElementById('explorer') as HTMLElement | null;
  let explorerPathEl = document.getElementById('explorerPath') as HTMLElement | null;
  let treeEl = document.getElementById('explorerTree') as HTMLElement | null;

  // context menu + inline form/confirm refs (항상 explorer 내부에 둠)
  let ctxMenuEl: HTMLElement | null = null;
  let ctxListEl: HTMLElement | null = null;
  let ctxFormEl: HTMLElement | null = null;
  let ctxFormTitleEl: HTMLElement | null = null;
  let ctxInputEl: HTMLInputElement | null = null;
  let ctxConfirmEl: HTMLElement | null = null;
  let ctxConfirmTextEl: HTMLElement | null = null;

  if (runBtn) runBtn.innerHTML = 'Enter';

  // 필수 루트 요소 검증 (없으면 진행 불가)
  if (!rootEl || !controlsEl || !sectionsEl || !splitter || !logsEl) {
    console.error('[edge-panel] Missing root elements', {
      rootEl: !!rootEl, controlsEl: !!controlsEl, sectionsEl: !!sectionsEl,
      splitter: !!splitter, logsEl: !!logsEl,
    });
    return;
  }

  rootEl.classList.remove('mode-normal', 'mode-debug'); // 과거 레이아웃 클래스 제거

  // ── 상태/타입 ────────────────────────────────────────────────
  type Kind = 'file' | 'folder';
  type TreeNode = {
    path: string;         // workspace 기준 상대경로 (''=root)
    name: string;         // 표시 명
    kind: Kind;
    el?: HTMLElement;     // .tree-node 엘리먼트
    parent?: TreeNode | null;
    children?: TreeNode[];
    expanded?: boolean;
    loaded?: boolean;     // children 로딩됨?
    selected?: boolean;
  };

  const state = {
    showLogs: false,
    showExplorer: false,
    explorerPath: '' as string, // 현재 breadcrumb 기준 경로
    root: null as TreeNode | null,
    nodesByPath: new Map<string, TreeNode>(),
    selected: null as TreeNode | null,
  };

  // ── 유틸 ─────────────────────────────────────────────────────
  const posixJoin = (...parts: string[]) =>
    parts.filter(Boolean).join('/').replace(/\/+/g, '/');

  function requestList(rel: string) {
    log('requestList ->', rel);
    vscode.postMessage({ type: 'explorer.list', path: rel || '' });
  }

  function getOrCreateNode(path: string, name: string, kind: Kind, parent: TreeNode | null): TreeNode {
    const key = path;
    let n = state.nodesByPath.get(key);
    if (!n) {
      n = { path, name, kind, parent, children: [], expanded: false, loaded: false, selected: false };
      state.nodesByPath.set(key, n);
    } else {
      n.name = name;
      n.kind = kind;
      n.parent = parent ?? null;
    }
    return n;
  }

  // ── 레이아웃 적용 ────────────────────────────────────────────
  function applyLayout() {
    const any = state.showLogs || state.showExplorer;
    rootEl!.style.display = 'grid';

    // CSS 클래스 토글(패널 CSS와 동기화)
    rootEl!.classList.toggle('show-logs', state.showLogs);
    rootEl!.classList.toggle('show-explorer', state.showExplorer);

    if (!any) {
      rootEl!.style.gridTemplateRows = '1fr';
      splitter!.style.display = 'none';
      logsEl!.style.display = 'none';
      if (cmdbarEl) cmdbarEl.style.display = 'none';
      closeCtxMenu();
      log('applyLayout -> control-only');
      return;
    }

    ensureCtrlBounds();

    if (state.showLogs) {
      rootEl!.style.gridTemplateRows = 'var(--ctrl-h) var(--splitter-h) 1fr var(--cmd-h)';
      splitter!.style.display = 'block';
      logsEl!.style.display = 'block';
      setLogsVisible(true);
      if (cmdbarEl) cmdbarEl.style.display = 'flex';
      if (explorerEl) explorerEl.style.display = 'none';
      closeCtxMenu();
      log('applyLayout -> logs');
      return;
    }

    // Explorer 모드 (explorer는 logs 영역 안에 동적 삽입)
    rootEl!.style.gridTemplateRows = 'var(--ctrl-h) var(--splitter-h) 1fr';
    splitter!.style.display = 'block';
    logsEl!.style.display = 'block';
    setLogsVisible(false); // 로그 라인은 감춤
    if (cmdbarEl) cmdbarEl.style.display = 'none';
    ensureExplorerDom();
    if (explorerEl) explorerEl.style.display = 'block';
    log('applyLayout -> explorer');
  }

  function setLogsVisible(v: boolean) {
    const nodes = logsEl!.querySelectorAll('.log-line');
    nodes.forEach((n) => ((n as HTMLElement).style.display = v ? '' : 'none'));
  }

  // ── Explorer DOM ─────────────────────────────────────────────
  function ensureExplorerDom() {
    if (!logsEl) return;
    let created = false;

    // 1) explorer 컨테이너가 없으면 생성 (항상 logs 내부에 둔다)
    if (!explorerEl) {
      explorerEl = document.createElement('section');
      explorerEl.id = 'explorer';
      explorerEl.setAttribute('aria-label', 'explorer');
      explorerEl.innerHTML = `
        <div id="explorerBar">
          <div id="explorerTitle">Explorer</div>
          <div id="explorerPath"></div>
        </div>
        <div id="explorerTree" role="tree" tabindex="0"></div>
      `;
      logsEl.appendChild(explorerEl);
      created = true;
    } else if (explorerEl.parentElement !== logsEl) {
      // 기존에 루트 등에 붙어있던 경우도 안전하게 logs 밑으로 이동
      logsEl.appendChild(explorerEl);
      created = true;
    }

    // 최신 레퍼런스 갱신
    explorerPathEl = explorerEl.querySelector('#explorerPath') as HTMLElement | null;
    treeEl = explorerEl.querySelector('#explorerTree') as HTMLElement | null;
    ctxMenuEl = explorerEl.querySelector('#ctxMenu') as HTMLElement | null;

    // 2) 스켈레톤 자기치유: 트리/바가 없다면 주입
    if (!explorerPathEl || !treeEl) {
      explorerEl.innerHTML = `
        <div id="explorerBar">
          <div id="explorerTitle">Explorer</div>
          <div id="explorerPath"></div>
        </div>
        <div id="explorerTree" role="tree" tabindex="0"></div>
      `;
      explorerPathEl = explorerEl.querySelector('#explorerPath') as HTMLElement | null;
      treeEl = explorerEl.querySelector('#explorerTree') as HTMLElement | null;
      log('explorer skeleton self-heal');
    }

    // 3) 컨텍스트 메뉴가 없으면 explorer 내부에 생성 (인라인 폼/컨펌 포함)
    if (!ctxMenuEl) {
      ctxMenuEl = document.createElement('div');
      ctxMenuEl.id = 'ctxMenu';
      ctxMenuEl.setAttribute('hidden', '');
      ctxMenuEl.innerHTML = `
        <div class="menu-list">
          <div class="menu-item" data-cmd="open">열기</div>
          <hr/>
          <div class="menu-item" data-cmd="new-file">새 파일</div>
          <div class="menu-item" data-cmd="new-folder">새 폴더</div>
          <hr/>
          <div class="menu-item" data-cmd="delete">삭제</div>
        </div>

        <div class="menu-form" hidden>
          <div class="menu-form-title"></div>
          <input id="ctxInput" type="text" spellcheck="false" />
          <div class="menu-actions">
            <button class="btn small" data-action="ok">확인</button>
            <button class="btn small ghost" data-action="cancel">취소</button>
          </div>
        </div>

        <div class="menu-confirm" hidden>
          <div class="menu-confirm-text"></div>
          <div class="menu-actions">
            <button class="btn small danger" data-action="yes">삭제</button>
            <button class="btn small ghost" data-action="no">취소</button>
          </div>
        </div>
      `;
      explorerEl.appendChild(ctxMenuEl);
      log('ctxMenu self-heal: created');
    }

    // 내부 레퍼런스 캐시
    const refreshCtxRefs = () => {
      ctxListEl = ctxMenuEl!.querySelector('.menu-list') as HTMLElement | null;
      ctxFormEl = ctxMenuEl!.querySelector('.menu-form') as HTMLElement | null;
      ctxFormTitleEl = ctxMenuEl!.querySelector('.menu-form-title') as HTMLElement | null;
      ctxInputEl = ctxMenuEl!.querySelector('#ctxInput') as HTMLInputElement | null;
      ctxConfirmEl = ctxMenuEl!.querySelector('.menu-confirm') as HTMLElement | null;
      ctxConfirmTextEl = ctxMenuEl!.querySelector('.menu-confirm-text') as HTMLElement | null;
    };
    refreshCtxRefs();

    // 4) (한 번만) ctxMenu 클릭/입력 핸들러 바인딩
    if (ctxMenuEl && !(ctxMenuEl as any)._bound) {
      (ctxMenuEl as any)._bound = 1;
      ctxMenuEl.addEventListener('click', onCtxMenuClick);
      ctxMenuEl.addEventListener('keydown', (e) => {
        if (ctxInputEl && !ctxInputEl.hidden && document.activeElement === ctxInputEl) {
          if ((e as KeyboardEvent).key === 'Enter') {
            e.preventDefault();
            submitCreate();
          } else if ((e as KeyboardEvent).key === 'Escape') {
            e.preventDefault();
            showMenuList();
          }
        }
      });
      log('bind: ctxMenu click handlers');
    }

    // 5) 트리 키/클릭 바인딩(1회)
    if (treeEl && !treeEl.dataset._bound) {
      treeEl.dataset._bound = '1';
      treeEl.addEventListener('keydown', onTreeKey);
      treeEl.addEventListener('click', (e) => {
        const nodeEl = (e.target as HTMLElement).closest('.tree-node') as HTMLElement | null;
        if (nodeEl) {
          const node = state.nodesByPath.get(nodeEl.dataset.path || '');
          if (node) selectNode(node);
        }
      });
      treeEl.addEventListener('dblclick', (e) => {
        const nodeEl = (e.target as HTMLElement).closest('.tree-node') as HTMLElement | null;
        if (!nodeEl) return;
        const node = state.nodesByPath.get(nodeEl.dataset.path || '');
        if (!node) return;
        if (node.kind === 'folder') toggleNode(node, true);
        else openFile(node);
      });
      log('bind: tree keyboard/click handlers');
    }

    // 6) Explorer 영역 우클릭 메뉴 (캡처 단계에서 기본 메뉴 차단)
    if (!explorerEl.dataset._ctxbound) {
      explorerEl.dataset._ctxbound = '1';
      document.addEventListener(
        'contextmenu',
        (e) => {
          const t = e.target as HTMLElement | null;
          if (!t) return;
          const inExplorer = !!t.closest('#explorer');
          if (!inExplorer) return; // 다른 곳은 기본 메뉴 허용
          e.preventDefault();
          e.stopPropagation();
          const li = t.closest('.tree-node') as HTMLElement | null;
          const targetNode = li ? state.nodesByPath.get(li?.dataset.path!) ?? null : null;
          const me = e as MouseEvent;
          log('contextmenu captured', { x: me.clientX, y: me.clientY, hasNode: !!targetNode });
          openCtxMenu(me.clientX, me.clientY, targetNode);
        },
        true, // capture
      );

      // 스크롤/리사이즈 시 메뉴 닫기
      logsEl.addEventListener('scroll', closeCtxMenu);
      window.addEventListener('resize', closeCtxMenu);
      log('bind: document contextmenu capture', { created });
    }

    log('ensureExplorerDom', {
      hasTree: !!treeEl,
      treeBound: !!treeEl?.dataset._bound,
      treeChildren: treeEl?.childElementCount,
    });
  }

  // ── Splitter/Control 높이 ────────────────────────────────────
  const cssNum = (v: string) => Number(v.replace(/[^\d.]/g, '')) || 0;
  const getCtrlH = () =>
    cssNum(getComputedStyle(document.documentElement).getPropertyValue('--ctrl-h'));
  const setCtrlH = (px: number) =>
    document.documentElement.style.setProperty('--ctrl-h', `${px}px`);
  const isContentVisible = () => state.showLogs || state.showExplorer;

  function computeMinCtrlPx(): number {
    const anyBtn = controlsEl!.querySelector('.btn') as HTMLElement | null;
    const h = anyBtn ? anyBtn.getBoundingClientRect().height : 32;
    const gap = 8, pad = 16;
    return Math.ceil(h * 2 + gap + pad * 2);
  }
  function ensureCtrlBounds() {
    if (!isContentVisible()) return;
    const minPx = computeMinCtrlPx();
    const maxPx = Math.floor(window.innerHeight * 0.5);
    const cur = Math.min(Math.max(getCtrlH(), minPx), maxPx);
    setCtrlH(cur);
  }
  window.addEventListener('resize', ensureCtrlBounds);

  // Drag
  let dragging = false, startY = 0, startH = 0;
  splitter!.addEventListener('mousedown', (e) => {
    if (!isContentVisible()) return;
    dragging = true;
    startY = (e as MouseEvent).clientY;
    startH = getCtrlH();
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = (e as MouseEvent).clientY - startY;
    const minPx = computeMinCtrlPx();
    const maxPx = Math.floor(window.innerHeight * 0.5);
    setCtrlH(Math.min(Math.max(startH + delta, minPx), maxPx));
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
  });
  splitter!.addEventListener('keydown', (e) => {
    if (!isContentVisible()) return;
    const step = (e as KeyboardEvent).shiftKey ? 16 : 8;
    if ((e as KeyboardEvent).key === 'ArrowUp' || (e as KeyboardEvent).key === 'ArrowDown') {
      e.preventDefault();
      const minPx = computeMinCtrlPx();
      const maxPx = Math.floor(window.innerHeight * 0.5);
      const cur = getCtrlH() + ((e as KeyboardEvent).key === 'ArrowUp' ? -step : step);
      setCtrlH(Math.min(Math.max(cur, minPx), maxPx));
    }
  });

  // ── Logs ─────────────────────────────────────────────────────
  function appendLog(line: string) {
    const div = document.createElement('div');
    div.className = 'log-line';
    if (line.includes('[E]')) {
      div.style.color = '#ff6b6b';
    } else if (line.includes('%READY%')) {
      div.style.color = '#98fb98';
      div.style.fontWeight = 'bold';
      div.style.fontStyle = 'italic';
      line = line.replace('%READY%', '').trimStart();
    }
    div.textContent = line;
    logsEl!.appendChild(div);
    logsEl!.scrollTop = logsEl!.scrollHeight;
  }
  function resetLogs(lines?: string[]) {
    logsEl!.innerHTML = '';
    if (Array.isArray(lines)) for (const l of lines) appendLog(l);
  }

  // ── Command run ──────────────────────────────────────────────
  function runCommand() {
    if (!inputEl) return;
    const text = (inputEl.value || '').trim();
    if (!text) return;
    appendLog(`edge> ${text}`);
    vscode.postMessage({ command: 'run', text, verbose: false });
    inputEl.value = '';
    if (cmdbarEl && cmdbarEl.offsetParent !== null) inputEl.focus();
  }
  inputEl?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      runBtn?.classList.add('pressed');
      setTimeout(() => runBtn?.classList.remove('pressed'), 120);
      runCommand();
    }
  });
  runBtn?.addEventListener('click', runCommand);

  // ── 섹션(Card) 렌더 ─────────────────────────────────────────
  type SectionDTO = { title: string; items: { id: string; label: string; desc?: string }[] };
  function renderSections(sections: SectionDTO[]) {
    sectionsEl!.innerHTML = '';
    sections.forEach((sec) => {
      const card = document.createElement('div');
      card.className = 'section-card';
      const h = document.createElement('h4');
      h.textContent = sec.title;
      card.appendChild(h);
      const body = document.createElement('div');
      body.className = 'section-body';
      sec.items.forEach((it) => {
        const b = document.createElement('button');
        b.className = 'btn';
        b.title = it.desc || it.label;
        b.textContent = it.label;
        b.addEventListener('click', () => {
          vscode.postMessage({ type: 'button.click', id: it.id });
        });
        body.appendChild(b);
      });
      card.appendChild(body);
      sectionsEl!.appendChild(card);
    });
    ensureCtrlBounds();
  }

  // ── Explorer: 렌더/조작 ─────────────────────────────────────
  function renderBreadcrumb(path: string) {
    ensureExplorerDom();
    if (!explorerPathEl) return;
    explorerPathEl.innerHTML = '';
    const segs = path ? path.split('/').filter(Boolean) : [];
    const rootCrumb = document.createElement('span');
    rootCrumb.className = 'crumb';
    rootCrumb.textContent = 'workspace';
    rootCrumb.addEventListener('click', () => {
      if (!state.root) return;
      state.explorerPath = '';
      collapseTo(state.root);
      selectNode(state.root);
    });
    explorerPathEl.appendChild(rootCrumb);

    let acc = '';
    segs.forEach((seg) => {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      explorerPathEl!.appendChild(sep);

      acc = posixJoin(acc, seg);
      const c = document.createElement('span');
      c.className = 'crumb';
      c.textContent = seg;
      c.addEventListener('click', () => {
        const node = state.nodesByPath.get(acc);
        if (node) {
          expandTo(node);
          selectNode(node);
        } else {
          state.explorerPath = acc;
          requestList(acc);
        }
      });
      explorerPathEl!.appendChild(c);
    });
  }

  function nodeLabel(node: TreeNode) {
    const wrap = document.createElement('div');
    wrap.className = 'tree-node';
    wrap.dataset.path = node.path;
    wrap.setAttribute('role', 'treeitem');
    wrap.setAttribute('aria-expanded', node.kind === 'folder' ? String(!!node.expanded) : 'false');

    const line = document.createElement('div');
    line.className = 'tn-line';
    const chevron = document.createElement('span');
    chevron.className = 'tn-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    const icon = document.createElement('span');
    icon.className = 'tn-icon';
    const label = document.createElement('span');
    label.className = 'tn-label';
    label.textContent = node.name;

    if (node.kind === 'folder') {
      icon.textContent = '📁';
      chevron.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleNode(node, true);
      });
    } else {
      icon.textContent = '📄';
      chevron.classList.add('tn-empty');
    }

    line.appendChild(chevron);
    line.appendChild(icon);
    line.appendChild(label);
    wrap.appendChild(line);

    if (node.kind === 'folder') {
      const group = document.createElement('div');
      group.className = 'tn-children';
      group.setAttribute('role', 'group');
      if (!node.expanded) group.style.display = 'none';
      wrap.appendChild(group);
    }

    return wrap;
  }

  function mountNode(parentEl: HTMLElement, node: TreeNode) {
    const el = nodeLabel(node);
    node.el = el;
    if (node.selected) el.classList.add('selected');
    parentEl.appendChild(el);
    log('mountNode', { parent: parentEl.id || parentEl.className, path: node.path, kind: node.kind });
  }

  function ensureChildrenContainer(node: TreeNode): HTMLElement | null {
    if (node.kind !== 'folder' || !node.el) return null;
    return node.el.querySelector('.tn-children') as HTMLElement | null;
  }

  function renderChildren(node: TreeNode, items: { name: string; kind: Kind }[]) {
    // 노드가 아직 DOM에 없을 수 있는 비동기 타이밍 방어
    if (!node.el) {
      if (node === state.root && treeEl) {
        mountNode(treeEl, node);
      } else if (node.parent) {
        const pg = ensureChildrenContainer(node.parent);
        if (pg) mountNode(pg, node);
      }
    }

    const group = ensureChildrenContainer(node);
    log('renderChildren: enter', { node: node.path, items: items.map(i => `${i.kind}:${i.name}`), hasGroup: !!group });
    if (!group) return;

    group.innerHTML = '';

    // 정렬: 폴더 우선, 이름순
    items.sort((a, b) =>
      a.kind === b.kind
        ? a.name.localeCompare(b.name, undefined, { numeric: true })
        : a.kind === 'folder' ? -1 : 1
    );

    node.children = items.map((it) => {
      const childPath = posixJoin(node.path, it.name);
      const child = getOrCreateNode(childPath, it.name, it.kind, node);
      mountNode(group, child);
      return child;
    });
    node.loaded = true;
    node.expanded = true;
    updateNodeExpanded(node);
    log('renderChildren: done', { node: node.path, childCount: group.childElementCount });
  }

  function collapseTo(node: TreeNode) {
    // 루트부터 해당 노드만 펼치고 나머지는 접기
    let cur: TreeNode | null = node;
    while (cur) {
      cur.expanded = true;
      updateNodeExpanded(cur);
      cur = cur.parent ?? null;
    }
    // 그 외 펼쳐진 폴더는 접기
    state.nodesByPath.forEach((n) => {
      if (n.kind === 'folder' && n !== node) {
        let p: TreeNode | null = node;
        let isAncestor = false;
        while (p) {
          if (p === n) { isAncestor = true; break; }
          p = p.parent ?? null;
        }
        if (!isAncestor) {
          n.expanded = false;
          updateNodeExpanded(n);
        }
      }
    });
    state.explorerPath = node.path;
    renderBreadcrumb(state.explorerPath);
  }

  function expandTo(node: TreeNode) {
    let cur: TreeNode | null = node;
    while (cur) {
      cur.expanded = true;
      updateNodeExpanded(cur);
      if (cur.kind === 'folder' && !cur.loaded) requestList(cur.path);
      cur = cur.parent ?? null;
    }
    state.explorerPath = node.path;
    renderBreadcrumb(state.explorerPath);
  }

  function updateNodeExpanded(node: TreeNode) {
    if (!node.el) return;
    const group = ensureChildrenContainer(node);
    node.el.setAttribute('aria-expanded', node.kind === 'folder' ? String(!!node.expanded) : 'false');
    node.el.classList.toggle('expanded', !!node.expanded);
    if (group) group.style.display = node.expanded ? '' : 'none';
    log('updateNodeExpanded', { path: node.path, expanded: !!node.expanded, groupVisible: group ? group.style.display !== 'none' : null });
  }

  function selectNode(node: TreeNode) {
    if (state.selected?.el) state.selected.el.classList.remove('selected');
    state.selected = node;
    if (node.el) node.el.classList.add('selected');
    if (node.kind === 'folder') state.explorerPath = node.path;
    renderBreadcrumb(state.explorerPath);
  }

  function toggleNode(node: TreeNode, focusAfter = false) {
    if (node.kind !== 'folder') return;
    node.expanded = !node.expanded;
    updateNodeExpanded(node);
    if (node.expanded && !node.loaded) requestList(node.path);
    if (focusAfter && node.el) (node.el as HTMLElement).focus?.();
  }

  function openFile(node: TreeNode) {
    if (node.kind !== 'file') return;
    vscode.postMessage({ type: 'explorer.open', path: node.path });
  }

  // ── Context Menu helpers ─────────────────────────────────────
  type CtxMode = 'menu' | 'new-file' | 'new-folder' | 'confirm-delete';
  let ctxTarget: TreeNode | null = null;
  let ctxMode: CtxMode = 'menu';
  let ctxBaseDir = '';

  function computeBaseDir(target: TreeNode | null): string {
    return (
      (target ? (target.kind === 'folder' ? target.path : (target.parent?.path ?? '')) : state.explorerPath) || ''
    );
  }

  function showMenuList() {
    ctxMode = 'menu';
    if (ctxListEl) ctxListEl.hidden = false;
    if (ctxFormEl) ctxFormEl.hidden = true;
    if (ctxConfirmEl) ctxConfirmEl.hidden = true;
  }

  function showCreateForm(kind: 'file' | 'folder') {
    ctxMode = kind === 'file' ? 'new-file' : 'new-folder';
    ctxBaseDir = computeBaseDir(ctxTarget);
    if (ctxListEl) ctxListEl.hidden = true;
    if (ctxConfirmEl) ctxConfirmEl.hidden = true;
    if (ctxFormEl) ctxFormEl.hidden = false;
    if (ctxFormTitleEl) ctxFormTitleEl.textContent = kind === 'file' ? '새 파일 이름' : '새 폴더 이름';
    if (ctxInputEl) {
      ctxInputEl.value = '';
      ctxInputEl.placeholder = kind === 'file' ? 'example.txt' : '새폴더';
      setTimeout(() => ctxInputEl?.focus(), 0);
    }
  }

  function showDeleteConfirm() {
    if (!ctxTarget) return;
    ctxMode = 'confirm-delete';
    if (ctxListEl) ctxListEl.hidden = true;
    if (ctxFormEl) ctxFormEl.hidden = true;
    if (ctxConfirmEl) ctxConfirmEl.hidden = false;
    if (ctxConfirmTextEl) ctxConfirmTextEl.textContent = `정말 삭제할까요?\n${ctxTarget.path}`;
  }

  function submitCreate() {
    const nm = (ctxInputEl?.value || '').trim();
    if (!nm) return;
    const full = posixJoin(ctxBaseDir, nm);
    if (ctxMode === 'new-file') {
      vscode.postMessage({ type: 'explorer.createFile', path: full });
    } else if (ctxMode === 'new-folder') {
      vscode.postMessage({ type: 'explorer.createFolder', path: full });
    }
    closeCtxMenu();
  }

  function confirmDeleteYes() {
    if (!ctxTarget) return;
    vscode.postMessage({
      type: 'explorer.delete',
      path: ctxTarget.path,
      recursive: ctxTarget.kind === 'folder',
      useTrash: true,
    });
    closeCtxMenu();
  }

  // ── Keyboard on tree ─────────────────────────────────────────
  function onTreeKey(e: KeyboardEvent) {
    const vis = visibleNodes();
    const cur = state.selected ? vis.indexOf(state.selected) : -1;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const n = vis[Math.min(vis.length - 1, cur + 1)];
      if (n) selectNode(n);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const n = vis[Math.max(0, cur - 1)];
      if (n) selectNode(n);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const n = state.selected;
      if (!n) return;
      if (n.kind === 'folder') {
        if (!n.expanded) toggleNode(n, true);
        else {
          const firstChild = n.children && n.children[0];
          if (firstChild) selectNode(firstChild);
        }
      }
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const n = state.selected;
      if (!n) return;
      if (n.kind === 'folder' && n.expanded) toggleNode(n, true);
      else if (n.parent) selectNode(n.parent);
      return;
    }
    if (e.key === 'Enter') {
      const n = state.selected;
      if (!n) return;
      if (n.kind === 'folder') toggleNode(n, true);
      else openFile(n);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
      // sandbox에서 confirm() 불가 → 인라인 확인 UI
      e.preventDefault();
      const li = state.selected.el as HTMLElement | null;
      const r = li?.getBoundingClientRect();
      const x = r ? r.left + Math.min(160, r.width) : 120;
      const y = r ? r.top + 24 : 120;
      openCtxMenu(x, y, state.selected);
      showDeleteConfirm();
    }
  }

  function visibleNodes(): TreeNode[] {
    const out: TreeNode[] = [];
    function walk(n: TreeNode) {
      if (n !== state.root) out.push(n);
      if (n.kind === 'folder' && n.expanded && n.children) n.children.forEach(walk);
    }
    if (state.root) walk(state.root);
    return out;
  }

  // ── 컨텍스트 메뉴 ───────────────────────────────────────────
  function openCtxMenu(x: number, y: number, target: TreeNode | null) {
    ensureExplorerDom(); // self-heal 보장
    if (!ctxMenuEl) return;
    ctxTarget = target;

    // 메뉴 모드를 초기화 (항상 리스트부터)
    showMenuList();

    // 화면 가장자리에서 벗어나지 않도록 최소 마진 적용
    const margin = 8;
    const maxX = Math.max(margin, Math.min(x, window.innerWidth - margin));
    const maxY = Math.max(margin, Math.min(y, window.innerHeight - margin));

    ctxMenuEl.style.left = `${maxX}px`;
    ctxMenuEl.style.top = `${maxY}px`;
    ctxMenuEl.hidden = false;

    const openBtn = ctxMenuEl.querySelector('[data-cmd="open"]') as HTMLElement | null;
    if (openBtn) openBtn.style.display = target && target.kind === 'file' ? 'block' : 'none';
    log('openCtxMenu', { x: maxX, y: maxY, target: target?.path, kind: target?.kind });
  }

  function closeCtxMenu() {
    if (ctxMenuEl) ctxMenuEl.hidden = true;
    ctxTarget = null;
    ctxMode = 'menu';
  }

  function onCtxMenuClick(e: Event) {
    const actionEl = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (actionEl) {
      const action = (actionEl.dataset as any).action as string;
      if (action === 'ok') submitCreate();
      else if (action === 'cancel' || action === 'no') showMenuList();
      else if (action === 'yes') confirmDeleteYes();
      return;
    }

    const btn = (e.target as HTMLElement).closest('.menu-item') as HTMLElement | null;
    if (!btn) return;
    const cmd = (btn.dataset as any).cmd as string;

    // 기준 경로 미리 계산 (생성 시 사용)
    ctxBaseDir = computeBaseDir(ctxTarget);
    const name = ctxTarget?.name || '';
    const kind = ctxTarget?.kind || '';

    log('ctxmenu click', { cmd, baseDir: ctxBaseDir, name, kind });

    if (cmd === 'open' && kind === 'file') {
      vscode.postMessage({ type: 'explorer.open', path: posixJoin(ctxBaseDir, name) });
      closeCtxMenu();
      return;
    }
    if (cmd === 'new-file') {
      showCreateForm('file');
      return;
    }
    if (cmd === 'new-folder') {
      showCreateForm('folder');
      return;
    }
    if (cmd === 'delete') {
      if (!ctxTarget) return;
      showDeleteConfirm();
      return;
    }
  }

  // 클릭/ESC 로 닫기
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    if (ctxMenuEl && !ctxMenuEl.hidden && t && !ctxMenuEl.contains(t)) closeCtxMenu();
  });
  document.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') closeCtxMenu(); });

  // ── Host → UI ────────────────────────────────────────────────
  window.addEventListener('message', (event) => {
    const msg = (event as MessageEvent<any>).data || {};
    switch (msg.type) {
      case 'initState': {
        const { logs } = msg.state || {};
        log('on:initState');
        resetLogs(logs);
        applyLayout();
        vscode.postMessage({ type: 'ui.requestButtons' });
        break;
      }

      case 'appendLog':
        if (typeof msg.text === 'string') appendLog(msg.text);
        break;

      case 'buttons.set':
        renderSections((msg.sections || []) as SectionDTO[]);
        break;

      // 패널 토글
      case 'ui.toggleLogs':
        state.showLogs = !state.showLogs;
        if (state.showLogs) state.showExplorer = false;
        log('toggle logs ->', state.showLogs);
        applyLayout();
        break;

      case 'ui.toggleExplorer':
        state.showExplorer = !state.showExplorer;
        log('toggle explorer ->', state.showExplorer);
        if (state.showExplorer) {
          state.showLogs = false;
          ensureExplorerDom();
          if (!state.root) {
            // 루트 노드 구성 후 목록 요청
            state.root = getOrCreateNode('', 'workspace', 'folder', null);
            state.root.loaded = false;
            state.root.expanded = true;
            if (treeEl) {
              treeEl.innerHTML = '';
              mountNode(treeEl, state.root);
            }
            requestList('');
          } else if (state.root && treeEl && !state.root.el) {
            // 안전망: root가 상태엔 있는데 DOM에 없으면 재부착
            treeEl.innerHTML = '';
            mountNode(treeEl, state.root);
          }
          renderBreadcrumb(state.explorerPath);
          treeEl?.focus();
        }
        applyLayout();
        break;

      // Explorer 응답
      case 'explorer.list.result': {
        const rel = String(msg.path || '');
        const items = (msg.items || []) as { name: string; kind: Kind }[];
        log('on:list.result', { rel, count: items.length, rootConnected: !!state.root?.el?.isConnected });

        if (!state.root) {
          // 안전망
          state.root = getOrCreateNode('', 'workspace', 'folder', null);
          if (treeEl) mountNode(treeEl, state.root);
        }
        const node = rel ? state.nodesByPath.get(rel) : state.root;
        if (!node) return;

        renderChildren(node, items);
        if (node === state.root && !state.selected) selectNode(state.root);
        break;
      }

      case 'explorer.ok': {
        log('on:ok', { op: msg.op, path: msg.path });
        // open 이외에는 현재 폴더를 refresh
        if (msg.op !== 'open') {
          const target = state.selected?.kind === 'folder' ? state.selected : (state.selected?.parent ?? state.root);
          if (target) requestList(target.path);
        }
        break;
      }

      case 'explorer.error': {
        console.error('[edge-panel] explorer.error', msg);
        alert(`탐색기 작업 실패: ${msg.message || msg.op || 'unknown'}`);
        break;
      }
    }
  });

  // ── Ready ───────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ command: 'ready' }));
  } else {
    vscode.postMessage({ command: 'ready' });
  }
  setTimeout(() => {
    if (inputEl && cmdbarEl && cmdbarEl.offsetParent !== null) inputEl.focus();
    applyLayout();
    vscode.postMessage({ type: 'ui.requestButtons' });
  }, 0);
})();
