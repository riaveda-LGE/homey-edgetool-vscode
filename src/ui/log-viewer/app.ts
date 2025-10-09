// === src/ui/log-viewer/app.ts ===
const logEl = document.getElementById('log')!;
declare const acquireVsCodeApi: () => any;
const vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : undefined;

// 웹뷰 준비 알림(선택)
vscode?.postMessage?.({ v:1, type:'ui.ready', payload:{} });

// Host → Webview 수신
window.addEventListener('message', (ev) => {
  const msg = ev.data || {};
  if (msg?.type === 'logs.batch') {
    const lines = msg.payload?.logs?.map((l:any) => `[${new Date(l.ts).toISOString()}] ${l.text}`) ?? [];
    logEl.textContent = lines.join('\n');
  }
});
