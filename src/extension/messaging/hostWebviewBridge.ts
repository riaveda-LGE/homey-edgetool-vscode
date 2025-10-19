// === src/extension/messaging/hostWebviewBridge.ts ===
import type { H2W, LogFilter, W2H } from '@ipc/messages';
import * as vscode from 'vscode';

import { getLogger } from '../../core/logging/extension-logger.js';
import { paginationService } from '../../core/logs/PaginationService.js';

type Handler = (msg: W2H, api: BridgeAPI) => Promise<void> | void;

export class HostWebviewBridge {
  private log = getLogger('bridge');
  private handlers = new Map<string, Handler>();
  private pendings = new Map<string, AbortController>(); // abortKey -> controller
  private seq = 0;
  private kickedOnce = false; // 초기 리프레시 신호를 중복 발사하지 않도록 가드
  // ── Search buffer (host-held) ────────────────────────────────────────
  private searchHits: { idx: number; text: string }[] = [];

  constructor(private readonly host: vscode.WebviewView | vscode.WebviewPanel) {}

  start() {
    this.host.webview.onDidReceiveMessage(async (raw: any) => {
      const msg = this.validateIncoming(raw);
      if (!msg) return;

      // ── 웹뷰가 준비 신호를 보낼 수 있는 경우(선행 핸드셰이크) ──
      if (msg.type === 'viewer.ready') {
        this.kickIfReady('viewer.ready');
        return;
      }
      // ── 필터 업데이트: "호스트가 head 500줄을 즉시 푸시" ──
      if (msg.type === 'logs.filter.update') {
        try {
          const filter = (msg.payload?.filter ?? {}) as LogFilter;
          this.log.info(`bridge: logs.filter.update ${JSON.stringify(filter)}`);
          paginationService.setFilter(filter);
          const total = await paginationService.getFilteredTotal();
          const head = await paginationService.readRangeByIdx(1, 500);
          // ① 바뀐 데이터의 head 500줄을 즉시 푸시
          this.send({
            v: 1,
            type: 'logs.batch',
            payload: { logs: head, total, seq: ++this.seq },
          } as any);
          // ② 상태(총계/버전)도 함께 브로드캐스트
          this.send({
            v: 1,
            type: 'logs.state',
            payload: {
              total,
              version: paginationService.getVersion(),
              warm: paginationService.isWarmupActive(),
              manifestDir: paginationService.getManifestDir(),
            },
          } as any);
          // ③ UI가 이전 요청/버퍼를 정리하고 새 페이지를 확정적으로 요청하도록 트리거
          this.send({
            v: 1,
            type: 'logs.refresh',
            payload: {
              reason: 'filter-changed',
              total,
              version: paginationService.getVersion(),
              warm: paginationService.isWarmupActive(),
            },
          } as any);
        } catch (err: any) {
          const message = err?.message || String(err);
          this.log.error(`bridge: FILTER_UPDATE_ERROR ${message}`);
          this.send({
            v: 1,
            type: 'error',
            payload: { code: 'FILTER_UPDATE_ERROR', message, detail: err, inReplyTo: msg.id },
          });
        }
        return;
      }

      // ── 온디맨드 페이지 로딩: 웹뷰가 스크롤 범위를 요청 ──
      if (msg.type === 'logs.page.request') {
        try {
          const { startIdx, endIdx } = msg.payload || {};
          const s = Number(startIdx) || 1;
          const e = Number(endIdx) || s;
          this.log.debug?.(
            `bridge: logs.page.request ${s}-${e} filterActive=${paginationService.isFilterActive()}`,
          );
          const logs = await paginationService.readRangeByIdx(s, e); // 내부에서 필터 적용 분기
          // 현재 pagination 버전을 함께 내려, 웹뷰가 세션 불일치를 걸러낼 수 있게 한다.
          this.send({
            v: 1,
            type: 'logs.page.response',
            payload: { startIdx: s, endIdx: e, logs, version: paginationService.getVersion() },
          } as any);
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

      // ── 서버측 필터 설정 ────────────────────────────────────────────────
      if (msg.type === 'logs.filter.set') {
        try {
          const filter = (msg.payload?.filter || {}) as LogFilter;
          this.log.info(`bridge: logs.filter.set ${JSON.stringify(filter)}`);
          paginationService.setFilter(filter);
          const total = await paginationService.getFilteredTotal();
          const head = await paginationService.readRangeByIdx(1, 500);
          this.send({
            v: 1,
            type: 'logs.batch',
            payload: { logs: head, total, seq: ++this.seq },
          } as any);
          // 상태도 함께 브로드캐스트
          this.send({
            v: 1,
            type: 'logs.state',
            payload: {
              total,
              version: paginationService.getVersion(),
              warm: paginationService.isWarmupActive(),
              manifestDir: paginationService.getManifestDir(),
            },
          } as any);
          this.send({
            v: 1,
            type: 'logs.refresh',
            payload: {
              reason: 'filter-changed',
              total,
              version: paginationService.getVersion(),
              warm: paginationService.isWarmupActive(),
            },
          } as any);
        } catch (err: any) {
          const message = err?.message || String(err);
          this.log.error(`bridge: FILTER_SET_ERROR ${message}`);
          this.send({
            v: 1,
            type: 'error',
            payload: { code: 'FILTER_SET_ERROR', message, detail: err, inReplyTo: msg.id },
          });
        }
        return;
      }

      // ── 서버측 필터 해제 ────────────────────────────────────────────────
      if (msg.type === 'logs.filter.clear') {
        try {
          this.log.info('bridge: logs.filter.clear');
          paginationService.setFilter(null);
          // 필터 해제 후 상단 500줄 재전송
          const total = await paginationService.getFilteredTotal();
          const head = await paginationService.readRangeByIdx(1, 500);
          this.send({
            v: 1,
            type: 'logs.batch',
            payload: { logs: head, total, seq: ++this.seq },
          } as any);
          this.send({
            v: 1,
            type: 'logs.state',
            payload: {
              total,
              version: paginationService.getVersion(),
              warm: paginationService.isWarmupActive(),
              manifestDir: paginationService.getManifestDir(),
            },
          } as any);
          this.send({
            v: 1,
            type: 'logs.refresh',
            payload: {
              reason: 'filter-changed',
              total,
              version: paginationService.getVersion(),
              warm: paginationService.isWarmupActive(),
            },
          } as any);
        } catch (err: any) {
          const message = err?.message || String(err);
          this.log.error(`bridge: FILTER_CLEAR_ERROR ${message}`);
          this.send({
            v: 1,
            type: 'error',
            payload: { code: 'FILTER_CLEAR_ERROR', message, detail: err, inReplyTo: msg.id },
          });
        }
        return;
      }
      // ──────────────────────────────────────────────

      // ── 전체 검색(노트패드++ 스타일): Enter 시 실행 ───────────────
      if (msg.type === 'search.query') {
        try {
          const q: string = String(msg?.payload?.q || '').trim();
          this.log.info(`bridge: search.query q="${q}"`);
          this.searchHits = [];
          if (q) {
            const total = await paginationService.getFilteredTotal();
            const N = Math.max(0, total || 0);
            const WINDOW = 2000;
            const ql = q.toLowerCase();
            for (let start = 1; start <= N; start += WINDOW) {
              const end = Math.min(N, start + WINDOW - 1);
              const part = await paginationService.readRangeByIdx(start, end);
              for (const e of part) {
                const txt = String(e.text || '');
                if (txt.toLowerCase().includes(ql)) {
                  this.searchHits.push({ idx: Number((e as any).idx) || start, text: txt });
                }
              }
            }
          }
          this.log.info(`bridge: search.results hits=${this.searchHits.length}`);
          this.send({ v: 1, type: 'search.results', payload: { hits: this.searchHits, q } } as any);
        } catch (err: any) {
          const message = err?.message || String(err);
          this.log.error(`bridge: SEARCH_ERROR ${message}`);
          this.send({
            v: 1,
            type: 'error',
            payload: { code: 'SEARCH_ERROR', message, inReplyTo: msg.id },
          });
        }
        return;
      }

      if (msg.type === 'search.clear') {
        this.log.info('bridge: search.clear');
        this.searchHits = [];
        this.send({ v: 1, type: 'search.results', payload: { hits: [], q: '' } } as any);
        return;
      }

      const h = this.handlers.get(msg.type);
      if (!h) return this.warnUnknown(msg.type);
      try {
        await h(msg, this.api());
      } catch (e) {
        this.sendError(e, msg.id);
      }
    });

    // 패널이 막 열렸을 때도 한 번 킥 — 최신 뷰어는 자체적으로 요청을 시작하지 않으므로
    // 다음 틱에 상태/리프레시 신호를 푸시한다.
    setTimeout(() => this.kickIfReady('bridge.start'), 0);
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

  /**
   * paginationService 상태를 확인해 웹뷰에 상태/리프레시 신호를 1회 발사한다.
   * - logs.state: 웹뷰가 UI 배너/프로그레스 등에 활용
   * - logs.refresh: 페이지 요청을 즉시 시작하도록 트리거
   */
  private kickIfReady(origin: 'bridge.start' | 'viewer.ready') {
    try {
      const warm = paginationService.isWarmupActive();
      const total = warm ? paginationService.getWarmTotal() : paginationService.getFileTotal();
      const version = paginationService.getVersion();
      const manifestDir = paginationService.getManifestDir();

      // 상태는 매번 보내도 무방(웹뷰가 최신값으로 덮어씀)
      this.send({
        v: 1,
        type: 'logs.state',
        payload: { warm, total, version, manifestDir },
      } as any);

      // 실제 페이징을 시작시키는 refresh는 세션당 1회만 보내면 충분
      if (!this.kickedOnce && (warm || !!manifestDir)) {
        this.send({
          v: 1,
          type: 'logs.refresh',
          payload: { reason: origin, total, version, warm },
        } as any);
        this.kickedOnce = true;
        this.log.info(
          `bridge: sent initial logs.refresh (origin=${origin}, warm=${warm}, total=${total ?? 'unknown'}, version=${version})`,
        );
      }
    } catch (e) {
      this.log.warn(`bridge: kickIfReady failed: ${String(e)}`);
    }
  }
}

export type BridgeAPI = {
  send: <T extends H2W>(msg: T) => void;
  request: <T extends H2W>(msg: Omit<T, 'id'>) => Promise<unknown>;
  registerAbort: (abortKey: string, controller: AbortController) => void;
  abort: (abortKey: string) => void;
};
