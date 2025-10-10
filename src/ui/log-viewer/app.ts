// === src/ui/log-viewer/app.ts ===
// 전역 선언 제거: d.ts에서 이미 선언됨
const logEl = document.getElementById('log')!;
const vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : undefined;

// 초기 ready 신호(선택)
vscode?.postMessage?.({ v:1, type:'ui.ready', payload:{} });

// Host ↔ Webview 메시지 수신
window.addEventListener('message', (ev) => {
  const msg = ev.data || {};
  if (msg?.type === 'logs.batch') {
    const lines = msg.payload?.logs?.map((l:any) => `[${new Date(l.ts).toISOString()}] ${l.text}`) ?? [];
    logEl.textContent = lines.join('\n');
  }
});
