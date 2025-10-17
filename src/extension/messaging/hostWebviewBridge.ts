// === src/extension/messaging/hostWebviewBridge.ts ===
import * as vscode from 'vscode';

import { getLogger } from '../../core/logging/extension-logger.js';
import { paginationService } from '../../core/logs/PaginationService.js';
import type { H2W, W2H } from './messageTypes.js';

type Handler = (msg: W2H, api: BridgeAPI) => Promise<void> | void;

export class HostWebviewBridge {
  private log = getLogger('bridge');
  private handlers = new Map<string, Handler>();
  private pendings = new Map<string, AbortController>(); // abortKey -> controller
  private seq = 0;

  constructor(private readonly host: vscode.WebviewView | vscode.WebviewPanel) {}

  start() {
    this.host.webview.onDidReceiveMessage(async (raw: any) => {
      const msg = this.validateIncoming(raw);
      if (!msg) return;

      // ── 온디맨드 페이지 로딩: 웹뷰가 스크롤 범위를 요청 ──
      if (msg.type === 'logs.page.request') {
        try {
          const { startIdx, endIdx } = msg.payload || {};
          const s = Number(startIdx) || 1;
          const e = Number(endIdx) || s;
          this.log.debug?.(`bridge: logs.page.request ${s}-${e}`);
          const logs = await paginationService.readRangeByIdx(s, e);
          this.send({ v: 1, type: 'logs.page.response', payload: { startIdx: s, endIdx: e, logs } });
          this.log.debug?.(`bridge: logs.page.response ${s}-${e} len=${logs.length}`);
        } catch (err: any) {
          const message = err?.message || String(err);
          this.log.error(`bridge: PAGE_READ_ERROR ${message}`);
          this.send({
            v: 1,
            type: 'error',
            payload: {
              code: 'PAGE_READ_ERROR',
              message,
              detail: err,
              inReplyTo: msg.id,
            },
          });
        }
        return;
      }
      // ──────────────────────────────────────────────

      const h = this.handlers.get(msg.type);
      if (!h) return this.warnUnknown(msg.type);
      try {
        await h(msg, this.api());
      } catch (e) {
        this.sendError(e, msg.id);
      }
    });
  }

  on(type: W2H['type'], handler: Handler) {
    this.handlers.set(type, handler);
    return { dispose: () => this.handlers.delete(type) };
  }

  send<T extends H2W>(msg: T) {
    this.host.webview.postMessage(msg);
  }

  request<T extends H2W>(msg: Omit<T, 'id'>): Promise<unknown> {
    const id = `req_${Date.now()}_${++this.seq}`;
    return new Promise((resolve) => {
      const disp = this.on('ack' as any, (ack: any) => {
        if (ack?.payload?.inReplyTo === id) {
          disp.dispose();
          resolve(ack.payload);
        }
      });
      this.host.webview.postMessage({ ...msg, id });
    });
  }

  registerAbort(abortKey: string, controller: AbortController) {
    this.abort(abortKey); // 기존 있으면 정리
    this.pendings.set(abortKey, controller);
  }

  abort(abortKey: string) {
    const c = this.pendings.get(abortKey);
    if (c) {
      c.abort();
      this.pendings.delete(abortKey);
    }
  }

  private api(): BridgeAPI {
    return {
      send: (m) => this.send(m),
      request: (m) => this.request(m),
      registerAbort: (k, c) => this.registerAbort(k, c),
      abort: (k) => this.abort(k),
    };
  }

  private validateIncoming(raw: any): W2H | null {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.v !== 1 || typeof raw.type !== 'string') return null;
    if (typeof raw.payload !== 'object') return null;
    return raw as W2H;
  }

  private warnUnknown(type: string) {
    this.log.warn(`unknown webview message: ${type}`);
  }

  private sendError(e: unknown, inReplyTo?: string) {
    const message = e instanceof Error ? e.message : String(e);
    const detail = e instanceof Error ? e.stack : e;
    this.log.error(`bridge: HOST_ERROR ${message}`);
    this.send({ v: 1, type: 'error', payload: { code: 'HOST_ERROR', message, detail, inReplyTo } });
  }
}

export type BridgeAPI = {
  send: <T extends H2W>(msg: T) => void;
  request: <T extends H2W>(msg: Omit<T, 'id'>) => Promise<unknown>;
  registerAbort: (abortKey: string, controller: AbortController) => void;
  abort: (abortKey: string) => void;
};
