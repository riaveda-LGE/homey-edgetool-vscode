// === src/ui/edge-panel/panel.ts ===
// 전역 선언 제거: d.ts에서 이미 선언됨

(function () {
  const vscode = acquireVsCodeApi();

  const controlsEl = document.getElementById('controls') as HTMLElement;
  const controlsContentEl = document.getElementById('controlsContent') as HTMLElement;
  const btnVersionUpdate = document.getElementById('btnVersionUpdate') as HTMLButtonElement | null;
  const btnReloadWindow = document.getElementById('btnReloadWindow') as HTMLButtonElement | null;
  const logsEl = document.getElementById('logs') as HTMLElement;
  const inputEl = document.getElementById('input') as HTMLInputElement;
  const runBtn = document.getElementById('runBtn') as HTMLButtonElement;

  if (runBtn) runBtn.innerHTML = 'Enter';

  function updateControlsVisibility() {
    if (!controlsContentEl) return;
    const visibleControls = Array.from(
      controlsContentEl.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, [data-control], .control',
      ),
    ).some((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    controlsEl.classList.toggle('hidden', !visibleControls);
  }

  controlsContentEl.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('#btnVersionUpdate')) {
      vscode.postMessage({ command: 'versionUpdate' });
    } else if (t.closest('#btnReloadWindow')) {
      vscode.postMessage({ command: 'reloadWindow' });
    }
  });

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
    if (Array.isArray(lines)) {
      for (const l of lines) appendLog(l);
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case 'initState': {
        const { updateAvailable, updateUrl, logs } = msg.state || {};
        const visible = !!(updateAvailable && updateUrl);
        if (btnVersionUpdate) btnVersionUpdate.style.display = visible ? '' : 'none';
        if (btnReloadWindow) btnReloadWindow.style.display = visible ? '' : 'none';
        updateControlsVisibility();
        resetLogs(logs);
        break;
      }
      case 'setUpdateVisible': {
        const visible = !!msg.visible;
        if (btnVersionUpdate) btnVersionUpdate.style.display = visible ? '' : 'none';
        if (btnReloadWindow) btnReloadWindow.style.display = visible ? '' : 'none';
        updateControlsVisibility();
        break;
      }
      case 'appendLog':
        if (typeof msg.text === 'string') appendLog(msg.text);
        break;
    }
  });

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

  if (btnVersionUpdate) btnVersionUpdate.style.display = 'none';
  if (btnReloadWindow) btnReloadWindow.style.display = 'none';
  updateControlsVisibility();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ command: 'ready' }));
  } else {
    vscode.postMessage({ command: 'ready' });
  }

  setTimeout(() => inputEl.focus(), 0);
})();
