import { createUiLog } from '../shared/utils.js';

const vscode = acquireVsCodeApi();
const uiLog = createUiLog(vscode, 'log-viewer');

const logEl = document.getElementById('log')!;

// 초기 ready 신호 (표준 Envelope)
vscode.postMessage({ v: 1, type: 'ui.ready' });

const lines: string[] = [];

function renderAppendBatch(batch: any[]) {
  if (!Array.isArray(batch) || batch.length === 0) return;

  try {
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
  } catch (e: any) {
    uiLog.error(`renderAppendBatch error: ${e?.message || String(e)}`);
  }
}

window.addEventListener('message', (ev) => {
  const msg = ev.data || {};
  if (msg?.type === 'logs.batch') {
    const arr = msg.payload?.logs ?? [];
    renderAppendBatch(arr);
  }
});

// (옵션) 초기 로드 메시지
uiLog.debug('log-viewer app initialized');
