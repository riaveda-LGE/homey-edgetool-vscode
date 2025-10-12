// === src/ui/edge-panel/panel.ts ===
(function () {
  const vscode = acquireVsCodeApi();

  const rootEl = document.getElementById('root') as HTMLElement;
  const controlsEl = document.getElementById('controls') as HTMLElement;
  const sectionsEl = document.getElementById('sections') as HTMLElement;

  const splitter = document.getElementById('splitter') as HTMLElement;
  const logsEl = document.getElementById('logs') as HTMLElement;
  const inputEl = document.getElementById('input') as HTMLInputElement;
  const runBtn  = document.getElementById('runBtn') as HTMLButtonElement;

  if (runBtn) runBtn.innerHTML = 'Enter';

  // ---------- Mode (normal/debug) ----------
  const savedMode = (localStorage.getItem('edge.mode') as 'mode-normal'|'mode-debug') || 'mode-normal';
  rootEl.classList.add(savedMode);

  function setMode(mode: 'mode-normal'|'mode-debug') {
    rootEl.classList.remove('mode-normal','mode-debug');
    rootEl.classList.add(mode);
    localStorage.setItem('edge.mode', mode);
    ensureCtrlBounds();
  }

  // 섹션 버튼에서 보낸 신호로 토글
  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg?.type === 'ui.toggleMode') {
      const next = rootEl.classList.contains('mode-debug') ? 'mode-normal' : 'mode-debug';
      setMode(next);
    }
  });

  // ---------- Control height bounds + Splitter ----------
  const cssNum = (v: string) => Number(v.replace(/[^\d.]/g, '')) || 0;
  const getCtrlH = () => cssNum(getComputedStyle(document.documentElement).getPropertyValue('--ctrl-h'));
  const setCtrlH = (px: number) => document.documentElement.style.setProperty('--ctrl-h', `${px}px`);

  function computeMinCtrlPx(): number {
    // "버튼 2개가 세로로 보일 수 있는 높이" 근사값
    const anyBtn = controlsEl.querySelector('.btn') as HTMLElement | null;
    const h = anyBtn ? anyBtn.getBoundingClientRect().height : 32;
    const gap = 8, pad = 16;
    return Math.ceil(h * 2 + gap + pad * 2);
  }
  function ensureCtrlBounds() {
    if (!rootEl.classList.contains('mode-debug')) return;
    const minPx = computeMinCtrlPx();
    const maxPx = Math.floor(window.innerHeight * 0.5); // 최대 50vh
    const cur = Math.min(Math.max(getCtrlH(), minPx), maxPx);
    setCtrlH(cur);
  }
  ensureCtrlBounds();
  window.addEventListener('resize', ensureCtrlBounds);

  // Mouse drag
  let dragging = false, startY = 0, startH = 0;
  splitter.addEventListener('mousedown', (e) => {
    if (!rootEl.classList.contains('mode-debug')) return;
    dragging = true; startY = e.clientY; startH = getCtrlH();
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = e.clientY - startY;
    const minPx = computeMinCtrlPx();
    const maxPx = Math.floor(window.innerHeight * 0.5);
    setCtrlH(Math.min(Math.max(startH + delta, minPx), maxPx));
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; document.body.style.userSelect = '';
  });
  // Keyboard (accessibility)
  splitter.addEventListener('keydown', (e) => {
    if (!rootEl.classList.contains('mode-debug')) return;
    const step = (e.shiftKey ? 16 : 8);
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const minPx = computeMinCtrlPx();
      const maxPx = Math.floor(window.innerHeight * 0.5);
      const cur = getCtrlH() + (e.key === 'ArrowUp' ? -step : step);
      setCtrlH(Math.min(Math.max(cur, minPx), maxPx));
    }
  });

  // ---------- Logs ----------
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
    logsEl.appendChild(div);
    logsEl.scrollTop = logsEl.scrollHeight;
  }
  function resetLogs(lines?: string[]) {
    logsEl.innerHTML = '';
    if (Array.isArray(lines)) for (const l of lines) appendLog(l);
  }

  // ---------- Command run ----------
  function runCommand() {
    const text = (inputEl.value || '').trim();
    if (!text) return;
    appendLog(`edge> ${text}`);
    vscode.postMessage({ command: 'run', text, verbose: false });
    inputEl.value = '';
    inputEl.focus();
  }
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      runBtn.classList.add('pressed');
      setTimeout(() => runBtn.classList.remove('pressed'), 120);
      runCommand();
    }
  });
  runBtn.addEventListener('click', runCommand);

  // ---------- 섹션(Card) 렌더 ----------
  type SectionDTO = { title: string; items: { id: string; label: string; desc?: string }[] };

  function renderSections(sections: SectionDTO[]) {
    sectionsEl.innerHTML = '';
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
          // 모든 버튼은 Host 디스패처로 식별자만 넘김
          vscode.postMessage({ type: 'button.click', id: it.id });
        });
        body.appendChild(b);
      });

      card.appendChild(body);
      sectionsEl.appendChild(card);
    });
    ensureCtrlBounds();
  }

  // ---------- Messages from host ----------
  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case 'initState': {
        const { logs } = msg.state || {};
        resetLogs(logs);
        break;
      }
      case 'setUpdateVisible': {
        // 상단 고정 버튼을 제거했으므로 무시
        break;
      }
      case 'appendLog':
        if (typeof msg.text === 'string') appendLog(msg.text);
        break;
      case 'buttons.set':
        renderSections((msg.sections || []) as SectionDTO[]);
        break;
    }
  });

  // ---------- Ready ----------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ command: 'ready' }));
  } else {
    vscode.postMessage({ command: 'ready' });
  }
  setTimeout(() => inputEl.focus(), 0);
})();
