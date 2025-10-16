import { createUiLog } from '../shared/utils.js';

(function () {
  const vscode = acquireVsCodeApi();

  // lightweight logger
  const uiLog = createUiLog(vscode, 'ui.edgePanel');

  const rootEl = document.getElementById('root') as HTMLElement | null;
  const controlsEl = document.getElementById('controls') as HTMLElement | null;
  const sectionsEl = document.getElementById('sections') as HTMLElement | null;

  const splitter = document.getElementById('splitter') as HTMLElement | null;
  const logsEl = document.getElementById('logs') as HTMLElement | null;

  // 콘텐츠 내부 스플리터 (explorer와 log 사이)
  let contentSplitter: HTMLElement | null = null;

  // explorer 영역은 필요 시 동적 생성(루트에 직접 붙임)
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

  // 필수 루트 요소 검증 (없으면 진행 불가)
  if (!rootEl || !controlsEl || !sectionsEl || !splitter || !logsEl) {
    uiLog.error(`[edge-panel] Missing root elements: rootEl=${!!rootEl}, controlsEl=${!!controlsEl}, sectionsEl=${!!sectionsEl}, splitter=${!!splitter}, logsEl=${!!logsEl}`);
    return;
  }

  // 토글 버튼 refs
  const toggleLogsEl = document.getElementById('toggleLogs') as HTMLButtonElement | null;
  const toggleExplorerEl = document.getElementById('toggleExplorer') as HTMLButtonElement | null;

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
    showExplorer: true, // 기본적으로 Explorer 열기
    explorerPath: '' as string, // 현재 breadcrumb 기준 경로
    root: null as TreeNode | null,
    nodesByPath: new Map<string, TreeNode>(),
    selected: [] as TreeNode[], // 다중 선택 배열
  };

  // 디바운스 타이머(폴더별)
  const refreshTimers = new Map<string, number>();

  // ── 유틸 ─────────────────────────────────────────────────────
  const posixJoin = (...parts: string[]) =>
    parts.filter(Boolean).join('/').replace(/\/+/g, '/');
  const dirOf = (p: string) => {
    const i = (p || '').lastIndexOf('/');
    return i >= 0 ? p.slice(0, i) : '';
  };

  function requestList(rel: string) {
    uiLog.info('[edge-panel] requestList -> ' + rel);
    vscode.postMessage({ v: 1, type: 'explorer.list', payload: { path: rel || '' } });
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
    const hasLogs = state.showLogs;
    const hasExplorer = state.showExplorer;
    uiLog.info('[edge-panel] applyLayout: showExplorer = ' + hasExplorer + ' showLogs = ' + hasLogs);
    const hasAny = hasLogs || hasExplorer;

    rootEl!.style.display = 'grid';

    // CSS 클래스 토글(패널 CSS와 동기화)
    rootEl!.classList.toggle('show-logs', hasLogs);
    rootEl!.classList.toggle('show-explorer', hasExplorer);
    rootEl!.classList.toggle('show-both', hasLogs && hasExplorer);

    if (!hasAny) {
      rootEl!.style.gridTemplateRows = '1fr';
      splitter!.style.display = 'none';
      // explorerEl, logContainer 숨김
      if (explorerEl) explorerEl.style.display = 'none';
      if (logContainer) logContainer.style.display = 'none';
      closeCtxMenu();
      uiLog.info('[edge-panel] applyLayout -> control-only');
      return;
    }

    ensureCtrlBounds();

    // 5행으로 변경: Control, Splitter1, Explorer, Splitter2, Log
    rootEl!.style.gridTemplateRows = 'var(--ctrl-h) var(--splitter-h) 1fr var(--splitter-h) 1fr';
    splitter!.style.display = 'block'; // Control ↔ Explorer 스플리터

    // Explorer 패널 표시/숨김 (독립)
    if (hasExplorer) {
      ensureExplorerDom();
      if (explorerEl && (!explorerEl.parentElement || explorerEl.parentElement !== rootEl)) {
        rootEl!.appendChild(explorerEl); // rootEl에 직접 붙임
      }
      explorerEl!.style.display = 'block';
      explorerEl!.style.gridRow = hasLogs ? '3' : '3'; // show-both: 3행, show-explorer: 3행
    } else {
      if (explorerEl) explorerEl.style.display = 'none';
      closeCtxMenu();
    }

    // Log 패널 표시/감춤 (독립)
    if (hasLogs) {
      if (!logContainer) {
        logContainer = document.createElement('div');
        logContainer.id = 'logContainer';
        logContainer.className = 'log-container';
      }
      if (!logContainer.parentElement || logContainer.parentElement !== rootEl) {
        rootEl!.appendChild(logContainer); // rootEl에 직접 붙임
      }
      logContainer.style.display = 'block';
      logContainer.style.gridRow = hasExplorer ? '5' : '3'; // show-both: 5행, show-logs: 3행
    } else {
      if (logContainer) logContainer.style.display = 'none';
    }

    // Content splitter for between explorer and log
    if (hasLogs && hasExplorer) {
      if (!contentSplitter) {
        contentSplitter = document.createElement('div');
        contentSplitter.id = 'contentSplitter';
        contentSplitter.className = 'content-splitter';
      }
      if (!contentSplitter.parentElement || contentSplitter.parentElement !== rootEl) {
        rootEl!.appendChild(contentSplitter);
      }
      contentSplitter.style.display = 'block';
      contentSplitter.style.gridRow = '4';
      ensureContentSplitter();
    } else {
      if (contentSplitter) contentSplitter.style.display = 'none';
    }

    ensureCtrlContentFit(); // control content가 다 보이도록 높이 조정 (사용자가 조정하지 않은 경우)
  }



  // ── Explorer DOM ─────────────────────────────────────────────
  function ensureExplorerDom() {
    if (!rootEl) return; // rootEl 확인
    let created = false;

    // 1) explorer 컨테이너가 없으면 생성 (루트에 직접 붙임)
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
      created = true;
    } else if (explorerEl.parentElement !== rootEl) {
      // 기존에 다른 위치에 붙어있다면 이동 (applyLayout에서 append)
      created = true;
    }

    // 최신 레퍼런스 갱신
    explorerPathEl = explorerEl.querySelector('#explorerPath') as HTMLElement | null;
    treeEl = explorerEl.querySelector('#explorerTree') as HTMLElement | null;
    ctxMenuEl = explorerEl.querySelector('#ctxMenu') as HTMLElement | null;

    // 2) 스켈레톤 자기치유
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
      uiLog.info('[edge-panel] explorer skeleton self-heal');
    }

    // 3) 컨텍스트 메뉴 (인라인 폼/확인 포함)
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
      uiLog.info('[edge-panel] ctxMenu self-heal: created');
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
      uiLog.info('[edge-panel] bind: ctxMenu click handlers');
    }

    // 5) 트리 키/클릭 바인딩(1회)
    if (treeEl && !treeEl.dataset._bound) {
      treeEl.dataset._bound = '1';
      treeEl.addEventListener('keydown', onTreeKey);
      treeEl.addEventListener('click', (e) => {
        const nodeEl = (e.target as HTMLElement).closest('.tree-node') as HTMLElement | null;
        if (nodeEl) {
          const node = state.nodesByPath.get(nodeEl.dataset.path || '');
          if (node) selectNode(node, (e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey);
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
      uiLog.info('[edge-panel] bind: tree keyboard/click handlers');
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
          uiLog.info('[edge-panel] contextmenu captured ' + JSON.stringify({ x: me.clientX, y: me.clientY, hasNode: !!targetNode }));
          openCtxMenu(me.clientX, me.clientY, targetNode);
        },
        true, // capture
      );

      // 스크롤/리사이즈 시 메뉴 닫기
      rootEl.addEventListener('scroll', closeCtxMenu);
      window.addEventListener('resize', closeCtxMenu);
      uiLog.info('[edge-panel] bind: document contextmenu capture ' + JSON.stringify({ created }));
    }

    uiLog.info('[edge-panel] ensureExplorerDom ' + JSON.stringify({
      hasTree: !!treeEl,
      treeBound: !!treeEl?.dataset._bound,
      treeChildren: treeEl?.childElementCount,
    }));
  }

  // ── Splitter/Control 높이 ────────────────────────────────────
  const cssNum = (v: string) => Number(v.replace(/[^\d.]/g, '')) || 0;
  const getCtrlH = () =>
    cssNum(getComputedStyle(document.documentElement).getPropertyValue('--ctrl-h'));
  const setCtrlH = (px: number) =>
    document.documentElement.style.setProperty('--ctrl-h', `${px}px`);
  const isContentVisible = () => state.showLogs || state.showExplorer;

  let userAdjustedControlHeight = false; // 사용자가 직접 조정한 적이 있는지

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
  function ensureCtrlContentFit() {
    if (!isContentVisible() || userAdjustedControlHeight) return;
    // control content가 다 보이도록 높이 설정
    const contentHeight = sectionsEl!.scrollHeight + 32; // padding 등 고려
    const maxPx = Math.floor(window.innerHeight * 0.5);
    setCtrlH(Math.min(contentHeight, maxPx));
  }
  window.addEventListener('resize', () => {
    if (!userAdjustedControlHeight) ensureCtrlContentFit();
    else ensureCtrlBounds();
  });

  // Drag (Control ↔ Explorer splitter)
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
    userAdjustedControlHeight = true; // 사용자가 조정했음
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    savePanelState(); // 드래그 종료 시 상태 저장
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
      userAdjustedControlHeight = true; // 사용자가 조정했음
      savePanelState(); // 키보드 조정 시 상태 저장
    }
  });

  // Drag (Explorer ↔ Log splitter)
  let contentDragging = false, contentStartY = 0, contentStartFlex = 0;
  function setupContentSplitter() {
    if (!contentSplitter) return;
    contentSplitter.addEventListener('mousedown', (e) => {
      if (!logContainer || !explorerEl) return;
      contentDragging = true;
      contentStartY = (e as MouseEvent).clientY;
      // 현재 explorerEl의 높이를 기반으로 flex 계산 (간단히 1:1로 시작)
      contentStartFlex = 0.5; // 기본 1:1
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
  }
  window.addEventListener('mousemove', (e) => {
    if (!contentDragging || !logContainer || !explorerEl) return;
    const delta = (e as MouseEvent).clientY - contentStartY;
    const totalHeight = rootEl!.clientHeight - getCtrlH() - 20; // 대략적인 총 높이 (splitter 높이 고려)
    const explorerHeight = Math.max(100, Math.min(totalHeight - 100, totalHeight * contentStartFlex + delta));
    const explorerFlex = explorerHeight / totalHeight;
    // Grid에서는 flex 대신 height로 조절 (단순화)
    explorerEl.style.height = `${explorerHeight}px`;
    logContainer.style.height = `${totalHeight - explorerHeight}px`;
  });
  window.addEventListener('mouseup', () => {
    if (!contentDragging) return;
    contentDragging = false;
    document.body.style.userSelect = '';
    savePanelState(); // content splitter 조정 시 상태 저장
  });

  // 스플리터 설정 (applyLayout에서 호출)
  function ensureContentSplitter() {
    if (contentSplitter && !contentSplitter.dataset._setup) {
      contentSplitter.dataset._setup = '1';
      setupContentSplitter();
    }
  }

  // ── Logs ─────────────────────────────────────────────────────
  function appendLog(line: string) {
    if (!logContainer) {
      logContainer = document.createElement('div');
      logContainer.id = 'logContainer';
      logContainer.className = 'log-container';
      rootEl!.appendChild(logContainer); // rootEl에 직접 붙임
    }
    const div = document.createElement('div');
    div.className = 'log-line';
    if (line.includes('[E]')) {
      div.style.color = '#ff6b6b';
    }
    div.textContent = line;
    logContainer.appendChild(div);
    logContainer.scrollTop = logContainer.scrollHeight;
  }
  function resetLogs(lines?: string[]) {
    if (!logContainer) {
      logContainer = document.createElement('div');
      logContainer.id = 'logContainer';
      logContainer.className = 'log-container';
      rootEl!.appendChild(logContainer); // rootEl에 직접 붙임
    }
    logContainer.innerHTML = '';
    if (Array.isArray(lines)) for (const l of lines) appendLog(l);
  }

  // 로그 컨테이너 추가 (로그 라인들을 감쌈)
  let logContainer: HTMLElement | null = null;

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
          vscode.postMessage({ v: 1, type: 'button.click', payload: { id: it.id } });
        });

        // 상태 표시: 켜짐 상태일 때 btn-on 클래스 추가
        if (it.id === 'panel.toggleLogs' && state.showLogs) {
          b.classList.add('btn-on');
        } else if (it.id === 'panel.toggleExplorer' && state.showExplorer) {
          b.classList.add('btn-on');
        }

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
    let el = node.el;
    if (!el) {
      el = nodeLabel(node);
      node.el = el;
    }
    if (node.selected) el.classList.add('selected');
    parentEl.appendChild(el);
    uiLog.info('[edge-panel] mountNode ' + JSON.stringify({ parent: parentEl.id || parentEl.className, path: node.path, kind: node.kind }));
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
    uiLog.info('[edge-panel] renderChildren: enter ' + JSON.stringify({ node: node.path, items: items.map(i => `${i.kind}:${i.name}`), hasGroup: !!group }));
    if (!group) return;

    group.innerHTML = ''; // 기존 DOM 요소 모두 제거

    // 기존 children 맵 생성
    const existing = new Map(node.children?.map(c => [c.name, c]) || []);
    node.children = [];

    // 정렬: 폴더 우선, 이름순
    items.sort((a, b) =>
      a.kind === b.kind
        ? a.name.localeCompare(b.name, undefined, { numeric: true })
        : a.kind === 'folder' ? -1 : 1
    );

    items.forEach((it) => {
      let child = existing.get(it.name);
      if (!child) {
        const childPath = posixJoin(node.path, it.name);
        child = getOrCreateNode(childPath, it.name, it.kind, node);
      }
      // 항상 mount (el 새로 만들고 append)
      mountNode(group, child);
      node.children!.push(child);
    });

    // items에 없는 기존 children 제거 (state에서만)
    existing.forEach((child, name) => {
      if (!items.some(it => it.name === name)) {
        state.nodesByPath.delete(child.path);
      }
    });

    node.loaded = true;
    node.expanded = true;
    updateNodeExpanded(node);
    uiLog.info('[edge-panel] renderChildren: done ' + JSON.stringify({ node: node.path, childCount: group.childElementCount }));
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
    // root 노드(workspace)는 항상 expanded 유지
    const isExpanded = node.path === '' ? true : !!node.expanded;
    node.el.setAttribute('aria-expanded', node.kind === 'folder' ? String(isExpanded) : 'false');
    node.el.classList.toggle('expanded', isExpanded);
    if (group) group.style.display = isExpanded ? '' : 'none';
    uiLog.info('[edge-panel] updateNodeExpanded ' + JSON.stringify({ path: node.path, expanded: isExpanded, groupVisible: group ? group.style.display !== 'none' : null }));
  }

  function selectNode(node: TreeNode, ctrlKey = false) {
    if (ctrlKey) {
      // 다중 선택: 토글
      const index = state.selected.indexOf(node);
      if (index > -1) {
        // 이미 선택됨: 제거
        state.selected.splice(index, 1);
        if (node.el) node.el.classList.remove('selected');
      } else {
        // 추가
        state.selected.push(node);
        if (node.el) node.el.classList.add('selected');
      }
    } else {
      // 단일 선택: 기존 선택 모두 해제 후 새로 선택
      state.selected.forEach(n => {
        if (n.el) n.el.classList.remove('selected');
      });
      state.selected = [node];
      if (node.el) node.el.classList.add('selected');
    }
    // breadcrumb는 첫 번째 선택된 노드로 설정 (단일 선택 시)
    if (state.selected.length === 1 && state.selected[0].kind === 'folder') {
      state.explorerPath = state.selected[0].path;
    }
    renderBreadcrumb(state.explorerPath);
  }

  function toggleNode(node: TreeNode, focusAfter = false) {
    if (node.kind !== 'folder') return;
    // root 노드(workspace)는 항상 expanded 유지
    if (node.path === '') return;
    node.expanded = !node.expanded;
    updateNodeExpanded(node);
    if (node.expanded && !node.loaded) requestList(node.path);
    if (node.expanded) scheduleFolderRefresh(node.path); // 펼쳐질 때 refresh 추가
    if (focusAfter && node.el) (node.el as HTMLElement).focus?.();
  }

  function openFile(node: TreeNode) {
    if (node.kind !== 'file') return;
    vscode.postMessage({ v: 1, type: 'explorer.open', payload: { path: node.path } });
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
      vscode.postMessage({ v: 1, type: 'explorer.createFile', payload: { path: full } });
    } else if (ctxMode === 'new-folder') {
      vscode.postMessage({ v: 1, type: 'explorer.createFolder', payload: { path: full } });
    }
    closeCtxMenu();
  }

  function confirmDeleteYes() {
    if (!ctxTarget) return;
    // 다중 선택된 항목 모두 삭제
    state.selected.forEach(node => {
      vscode.postMessage({
        v: 1,
        type: 'explorer.delete',
        payload: {
          path: node.path,
          recursive: node.kind === 'folder',
          useTrash: true,
        },
      });
    });
    closeCtxMenu();
  }

  // ── Keyboard on tree ─────────────────────────────────────────
  function onTreeKey(e: KeyboardEvent) {
    const vis = visibleNodes();
    const cur = state.selected.length > 0 ? vis.indexOf(state.selected[0]) : -1;

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
      const n = state.selected[0];
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
      const n = state.selected[0];
      if (!n) return;
      if (n.kind === 'folder' && n.expanded) toggleNode(n, true);
      else if (n.parent) selectNode(n.parent);
      return;
    }
    if (e.key === 'Enter') {
      const n = state.selected[0];
      if (!n) return;
      if (n.kind === 'folder') toggleNode(n, true);
      else openFile(n);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected.length > 0) {
      // sandbox에서 confirm() 불가 → 인라인 확인 UI
      e.preventDefault();
      const li = state.selected[0].el as HTMLElement | null;
      const r = li?.getBoundingClientRect();
      const x = r ? r.left + Math.min(160, r.width) : 120;
      const y = r ? r.top + 24 : 120;
      openCtxMenu(x, y, state.selected[0]); // 첫 번째 선택된 노드로 메뉴 열기
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
    uiLog.info('[edge-panel] openCtxMenu ' + JSON.stringify({ x: maxX, y: maxY, target: target?.path, kind: target?.kind }));
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

    uiLog.info('[edge-panel] ctxmenu click ' + JSON.stringify({ cmd, baseDir: ctxBaseDir, name, kind }));

    if (cmd === 'open' && kind === 'file') {
      vscode.postMessage({ v: 1, type: 'explorer.open', payload: { path: posixJoin(ctxBaseDir, name) } });
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

  // 토글 버튼 이벤트
  if (toggleLogsEl) {
    toggleLogsEl.addEventListener('click', () => {
      state.showLogs = !state.showLogs;
      uiLog.info('[edge-panel] logs toggled to: ' + state.showLogs);
      applyLayout();
      savePanelState();
    });
  }
  if (toggleExplorerEl) {
    toggleExplorerEl.addEventListener('click', () => {
      state.showExplorer = !state.showExplorer;
      uiLog.info('[edge-panel] explorer toggled to: ' + state.showExplorer);
      applyLayout();
      savePanelState();
    });
  }

  // ── Host → UI ────────────────────────────────────────────────
  function scheduleFolderRefresh(dir: string) {
    uiLog.info('[edge-panel] scheduleFolderRefresh called for dir: ' + dir + ' viewing: ' + state.explorerPath);
    // 현재 표시(crumb) 폴더만 갱신
    if (!state.showExplorer) return;
    const viewing = state.explorerPath || '';
    // dir이 viewing이 아니어도, dir 폴더가 expanded이면 갱신 (자식 변경 감지)
    const node = state.nodesByPath.get(dir);
    if (dir !== viewing && (!node || !node.expanded)) return;
    const prev = refreshTimers.get(dir); // 폴더별 타이머
    if (prev) clearTimeout(prev);
    const t = window.setTimeout(() => {
      refreshTimers.delete(dir);
      requestList(dir);
    }, 150);
    refreshTimers.set(dir, t as unknown as number);
  }

  window.addEventListener('message', (event) => {
    const msg = (event as MessageEvent<any>).data || {};
    switch (msg.type) {
      case 'initState': {
        const { logs } = msg.payload.state || {};
        uiLog.info('[edge-panel] on:initState');
        resetLogs(logs);
        
        // 저장된 패널 상태 불러오기
        if (msg.payload.panelState) {
          const ps = msg.payload.panelState;
          state.showExplorer = ps.showExplorer ?? true;
          state.showLogs = ps.showLogs ?? false;
          if (ps.controlHeight) {
            setCtrlH(ps.controlHeight);
            userAdjustedControlHeight = true; // 저장된 값이 있으면 사용자가 조정한 것으로 간주
          }
          if (ps.splitterPosition && ps.splitterPosition > 0 && ps.splitterPosition < 1) {
            // content splitter 위치 복원 (다음 틱에서 실행)
            setTimeout(() => {
              if (state.showLogs && state.showExplorer && explorerEl && logContainer) {
                const totalHeight = rootEl!.clientHeight - getCtrlH() - 20; // splitter 높이 고려
                const explorerHeight = Math.round(totalHeight * ps.splitterPosition);
                const logHeight = totalHeight - explorerHeight;
                explorerEl.style.height = `${explorerHeight}px`;
                logContainer.style.height = `${logHeight}px`;
              }
            }, 0);
          }
        }
        
        applyLayout();
        vscode.postMessage({ v: 1, type: 'ui.requestButtons', payload: {} });
        break;
      }

      case 'appendLog':
        if (typeof msg.payload.text === 'string') appendLog(msg.payload.text);
        break;

      case 'buttons.set':
        renderSections((msg.payload.sections || []) as SectionDTO[]);
        break;

      // 패널 토글
      case 'ui.toggleLogs':
        state.showLogs = !state.showLogs;
        uiLog.info('[edge-panel] toggle logs -> ' + state.showLogs);
        applyLayout();
        savePanelState();
        vscode.postMessage({ v: 1, type: 'ui.requestButtons', payload: {} });
        break;

      case 'ui.toggleExplorer':
        state.showExplorer = !state.showExplorer;
        uiLog.info('[edge-panel] toggle explorer -> ' + state.showExplorer);
        if (state.showExplorer) {
          ensureExplorerDom();
          vscode.postMessage({ v: 1, type: 'workspace.ensure', payload: {} });
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
        savePanelState();
        vscode.postMessage({ v: 1, type: 'ui.requestButtons', payload: {} });
        break;

      // Explorer 응답
      case 'explorer.list.result': {
        const rel = String(msg.payload.path || '');
        const items = (msg.payload.items || []) as { name: string; kind: Kind }[];
        uiLog.info('[edge-panel] on:list.result ' + JSON.stringify({ rel, count: items.length, rootConnected: !!state.root?.el?.isConnected }));

        if (!state.root) {
          // 안전망
          state.root = getOrCreateNode('', 'workspace', 'folder', null);
          if (treeEl) mountNode(treeEl, state.root);
        }
        const node = rel ? state.nodesByPath.get(rel) : state.root;
        if (!node) return;

        renderChildren(node, items);
        if (node === state.root && state.selected.length === 0) selectNode(state.root);
        break;
      }

      case 'explorer.ok': {
        uiLog.info('[edge-panel] on:ok ' + JSON.stringify({ op: msg.payload.op, path: msg.payload.path }));
        if (msg.payload.op === 'delete') {
          // 삭제 시 특별 처리: 부모 폴더 refresh, 선택 상태 정리
          const deletedPath = String(msg.payload.path || '');
          const parentPath = dirOf(deletedPath);
          
          // 삭제된 경로로 시작하는 모든 노드 제거 (recursive 삭제 지원)
          const toRemove: string[] = [];
          state.nodesByPath.forEach((node, path) => {
            if (path === deletedPath || path.startsWith(deletedPath + '/')) {
              toRemove.push(path);
              if (node.el && node.el.parentElement) {
                node.el.parentElement.removeChild(node.el);
              }
            }
          });
          toRemove.forEach(path => state.nodesByPath.delete(path));
          
          // 삭제된 노드가 선택되어 있다면 선택 해제
          state.selected = state.selected.filter(node => !toRemove.includes(node.path));
          
          // 현재 보고 있는 폴더가 삭제된 폴더라면 상위로 이동
          if (state.explorerPath === deletedPath || state.explorerPath.startsWith(deletedPath + '/')) {
            state.explorerPath = parentPath;
            renderBreadcrumb(state.explorerPath);
          }
          
          // 부모 폴더 refresh
          requestList(parentPath);
        } else if (msg.payload.op === 'createFile' || msg.payload.op === 'createFolder') {
          // 생성 작업은 생성된 항목의 부모 폴더 refresh
          const parentDir = dirOf(String(msg.payload.path || ''));
          requestList(parentDir);
        } else if (msg.op !== 'open') {
          // 다른 작업은 현재 폴더 refresh
          const firstSelected = state.selected[0];
          const target = firstSelected?.kind === 'folder' ? firstSelected : (firstSelected?.parent ?? state.root);
          if (target) requestList(target.path);
        }
        break;
      }

      case 'explorer.fs.changed': {
        // 확장 쪽에서 변경 감지 → 현재 폴더와 동일한 상위면 갱신
        uiLog.info('[edge-panel] explorer.fs.changed received: ' + msg.payload.path);
        const changedRel = String(msg.payload.path || '');
        const dir = dirOf(changedRel);
        scheduleFolderRefresh(dir);
        break;
      }

      case 'explorer.root.changed': {
        // 워크스페이스 루트가 바뀜 → 상태 초기화 후 루트부터 재요청
        uiLog.info('[edge-panel] on:root.changed');
        state.root = null;
        state.nodesByPath.clear();
        state.selected = [];
        state.explorerPath = '';
        ensureExplorerDom();
        if (treeEl) treeEl.innerHTML = '';
        state.root = getOrCreateNode('', 'workspace', 'folder', null);
        if (treeEl) mountNode(treeEl, state.root);
        renderBreadcrumb(state.explorerPath);
        requestList('');
        break;
      }

      case 'explorer.error': {
        uiLog.error(`explorer.error: ${JSON.stringify(msg.payload)}`);
        alert(`탐색기 작업 실패: ${msg.payload.message || msg.payload.op || 'unknown'}`);
        break;
      }
    }
  });

  // ── 상태 저장 ──────────────────────────────────────────────
  function savePanelState() {
    // content splitter 위치 계산 (explorer 높이 비율)
    let splitterPosition: number | undefined;
    if (state.showLogs && state.showExplorer && explorerEl && logContainer) {
      const explorerHeight = parseFloat(explorerEl.style.height || '0');
      const logHeight = parseFloat(logContainer.style.height || '0');
      const totalHeight = explorerHeight + logHeight;
      if (totalHeight > 0) {
        splitterPosition = explorerHeight / totalHeight;
      }
    }

    const panelState = {
      showExplorer: state.showExplorer,
      showLogs: state.showLogs,
      controlHeight: getCtrlH(),
      splitterPosition,
    };
    vscode.postMessage({ v: 1, type: 'ui.savePanelState', payload: { panelState } });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ v: 1, type: 'ui.ready', payload: {} }));
  } else {
    vscode.postMessage({ v: 1, type: 'ui.ready', payload: {} });
  }
  setTimeout(() => {
    applyLayout();
    // 초기 로딩 시 Control 패널이 모든 버튼이 보이도록 높이 조정
    ensureCtrlContentFit();
    vscode.postMessage({ v: 1, type: 'ui.requestButtons', payload: {} });
  }, 0);
})();