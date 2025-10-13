// === src/ui/_shared/bridge.ts ===
// Webview 런타임 공용 브리지 유틸 (post/request/ack/error/abortKey)

type AnyMsg = { v: 1; type: string; id?: string; payload?: any; abortKey?: string };

function getApi(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (typeof acquireVsCodeApi === 'function') return acquireVsCodeApi();
  } catch {}
  return undefined;
}

export function makeBridge(api: any = getApi()) {
  let seq = 0;
  const pend = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();

  // ack/error 수신
  window.addEventListener('message', (ev) => {
    const m: AnyMsg = ev.data || {};
    if (!m || m.v !== 1) return;

    // host → webview 에러 표준 메시지
    if (m.type === 'error' && (m as any).payload?.inReplyTo) {
      const id = (m as any).payload.inReplyTo as string;
      const p = pend.get(id);
      if (p) {
        p.reject((m as any).payload);
        pend.delete(id);
      }
      return;
    }

    // ack (간단 합의: { type:'ack', payload:{ inReplyTo, ... } })
    if (m.type === 'ack' && (m as any).payload?.inReplyTo) {
      const id = (m as any).payload.inReplyTo as string;
      const p = pend.get(id);
      if (p) {
        p.resolve((m as any).payload);
        pend.delete(id);
      }
      return;
    }
  });

  const post = (type: string, payload?: any, abortKey?: string) => {
    const msg: AnyMsg = { v: 1, type, payload, abortKey };
    api?.postMessage?.(msg);
  };

  const request = (type: string, payload?: any, abortKey?: string) => {
    const id = `req_${Date.now()}_${++seq}`;
    const msg: AnyMsg = { v: 1, id, type, payload, abortKey };
    api?.postMessage?.(msg);
    return new Promise((resolve, reject) => {
      pend.set(id, { resolve, reject });
      // 필요 시 타임아웃/abort 관리 추가 가능
    });
  };

  return { post, request };
}

// 간단한 UI 로거
export function makeUiLogger(bridge: ReturnType<typeof makeBridge>, source?: string) {
  const send = (level: 'debug' | 'info' | 'warn' | 'error', text: string) =>
    bridge.post('ui.log', { level, text, source });

  return {
    debug: (t: string) => send('debug', t),
    info: (t: string) => send('info', t),
    warn: (t: string) => send('warn', t),
    error: (t: string) => send('error', t),
  };
}
