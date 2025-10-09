(function () {
  const vscode = acquireVsCodeApi();

  const controlsEl = document.getElementById('controls');
  const controlsContentEl = document.getElementById('controlsContent');
  const btnVersionUpdate = document.getElementById('btnVersionUpdate');
  const btnReloadWindow = document.getElementById('btnReloadWindow');
  const logsEl = document.getElementById('logs');
  const inputEl = document.getElementById('input');
  const runBtn = document.getElementById('runBtn');

  // 보수적으로 HTML 라벨을 보장 (캐시/핫리로드 대비)
  if (runBtn) runBtn.innerHTML = 'Enter';

  function updateControlsVisibility() {
    if (!controlsContentEl) return;
    const visibleControls = Array.from(
      controlsContentEl.querySelectorAll(
        'button, input, select, textarea, [data-control], .control',
      ),
    ).some((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    controlsEl.classList.toggle('hidden', !visibleControls);
  }

  controlsContentEl.addEventListener('click', (e) => {
    if (e.target.closest('#btnVersionUpdate')) {
      vscode.postMessage({ command: 'versionUpdate' });
    } else if (e.target.closest('#btnReloadWindow')) {
      vscode.postMessage({ command: 'reloadWindow' });
    }
  });

  function appendLog(line) {
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

  function resetLogs(lines) {
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
      default:
        break;
    }
  });

  function runCommand() {
    const text = (inputEl.value || '').trim();
    if (!text) return;
    appendLog(`edge> ${text}`); // 에코
    vscode.postMessage({ command: 'run', text, verbose: false });
    inputEl.value = '';
    inputEl.focus();
  }

  // Enter 키 → 실행 + 버튼 '눌림' 효과
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

  // 핸드셰이크
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ command: 'ready' }));
  } else {
    vscode.postMessage({ command: 'ready' });
  }

  setTimeout(() => inputEl.focus(), 0);
})();
