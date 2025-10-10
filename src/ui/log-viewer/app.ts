// === src/ui/log-viewer/app.ts ===
const logEl = document.getElementById('log')!;

// ⚠️ 중복 선언 제거: types/vscode-webview.d.ts 에서 전역 선언됨
// declare const acquireVsCodeApi: () => any;

const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;

// 초기 ready 신호
vscode?.postMessage?.({ v: 1, type: 'ui.ready', payload: {} });

// 간단한 버퍼 (필요시 사용)
const lines: string[] = [];

function renderAppendBatch(batch: any[]) {
  if (!Array.isArray(batch) || batch.length === 0) return;

  const mapped = batch.map((l) => {
    const ts = typeof l.ts === 'number' ? l.ts : Date.now();
    const text = String(l.text ?? '');
    return { ts, text };
  });

  mapped.sort((a, b) => a.ts - b.ts);

  for (const m of mapped) {
    lines.push(`[${new Date(m.ts).toISOString()}] ${m.text}`);
  }

  const frag = document.createDocumentFragment();
  for (const m of mapped) {
    const div = document.createElement('div');
    div.textContent = `[${new Date(m.ts).toISOString()}] ${m.text}`;
    frag.appendChild(div);
  }
  logEl.appendChild(frag);
  logEl.scrollTop = logEl.scrollHeight;
}

window.addEventListener('message', (ev) => {
  const msg = ev.data || {};
  if (msg?.type === 'logs.batch') {
    const arr = msg.payload?.logs ?? [];
    renderAppendBatch(arr);
  }
});
