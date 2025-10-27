// === src/ui/_shared/bridge.ts ===
// Webview 런타임 공용 브리지 유틸 (post/request/ack/error/abortKey)

import { globalProfiler, measureBlock, perfNow } from '../../core/logging/perf.js';

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

  type Pending = {
    resolve: (v: any) => void;
    reject: (e: any) => void;
    abortKey?: string;
    timer?: number;
  };

  const pend = new Map<string, Pending>(); // id -> pending
  const byAbortKey = new Map<string, { id: string }>(); // abortKey -> id
  const DEFAULT_TIMEOUT_MS = 15_000;

  const cleanupPending = (id: string) => {
    const p = pend.get(id);
    if (!p) return;
    if (typeof p.timer === 'number') clearTimeout(p.timer);
    if (p.abortKey && byAbortKey.get(p.abortKey)?.id === id) {
      byAbortKey.delete(p.abortKey);
    }
    pend.delete(id);
  };

  // ack/error 수신
  window.addEventListener('message', (ev) => {
    const run = () => {
      const m: AnyMsg = ev.data || {};
      if (!m || m.v !== 1) return;

      // host → webview 에러 표준 메시지
      if (m.type === 'error' && (m as any).payload?.inReplyTo) {
        const id = (m as any).payload.inReplyTo as string;
        const p = pend.get(id);
        if (p) {
          p.reject((m as any).payload);
          cleanupPending(id);
        }
        return;
      }

      // ack (간단 합의: { type:'ack', payload:{ inReplyTo, ... } })
      if (m.type === 'ack' && (m as any).payload?.inReplyTo) {
        const id = (m as any).payload.inReplyTo as string;
        const p = pend.get(id);
        if (p) {
          p.resolve((m as any).payload);
          cleanupPending(id);
        }
        return;
      }
    };
    if (globalProfiler.isOn()) {
      void measureBlock('ui.bridge.onMessage', async () => run());
    } else {
      run();
    }
  });

  // webview가 내려갈 때(탭 닫힘 등) 미해결 프라미스 정리
  window.addEventListener('unload', () => {
    for (const [id, p] of Array.from(pend.entries())) {
      try {
        p.reject({ code: 'unloaded', message: 'webview unloaded before response' });
      } catch {}
      cleanupPending(id);
    }
  });

  const post = (type: string, payload?: any, abortKey?: string) => {
    const msg: AnyMsg = { v: 1, type, payload, abortKey };
    if (!globalProfiler.isOn()) {
      api?.postMessage?.(msg);
      return;
    }
    const t0 = perfNow();
    try {
      api?.postMessage?.(msg);
    } finally {
      globalProfiler.recordFunctionCall('ui.bridge.post', t0, perfNow() - t0);
    }
  };

  const request = (type: string, payload?: any, abortKey?: string) => {
    const impl = () => {
      const id = `req_${Date.now()}_${++seq}`;

      // 동일 abortKey의 이전 요청이 있으면 UI측에서 선제 거절(교체)
      if (abortKey) {
        const prev = byAbortKey.get(abortKey);
        if (prev) {
          const prevPend = pend.get(prev.id);
          if (prevPend) {
            try {
              prevPend.reject({
                code: 'aborted_by_newer_request',
                message: 'Superseded by a newer request with the same abortKey',
              });
            } catch {}
            cleanupPending(prev.id);
          }
        }
        byAbortKey.set(abortKey, { id });
      }

      const msg: AnyMsg = { v: 1, id, type, payload, abortKey };
      api?.postMessage?.(msg);

      return new Promise((resolve, reject) => {
        // 타임아웃 설정(필요 시 payload.__timeoutMs로 오버라이드 가능)
        const timeoutMs =
          payload && typeof payload.__timeoutMs === 'number' && payload.__timeoutMs > 0
            ? payload.__timeoutMs
            : DEFAULT_TIMEOUT_MS;

        const timer = window.setTimeout(() => {
          const p = pend.get(id);
          if (p) {
            try {
              p.reject({ code: 'timeout', message: `request timed out: ${type}` });
            } catch {}
            cleanupPending(id);
          }
        }, timeoutMs);

        pend.set(id, { resolve, reject, abortKey, timer });
        // 필요 시 추가 abort 메커니즘(외부 signal)도 여기에 결합 가능
      });
    };
    if (globalProfiler.isOn()) {
      return measureBlock('ui.bridge.request', async () => impl());
    }
    return impl();
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
