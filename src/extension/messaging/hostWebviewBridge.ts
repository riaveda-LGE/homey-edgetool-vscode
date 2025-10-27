// === src/extension/messaging/hostWebviewBridge.ts ===
import type { H2W, LogFilter, W2H } from '@ipc/messages';
import * as vscode from 'vscode';

import { getLogger } from '../../core/logging/extension-logger.js';
import { globalProfiler, measure, measureBlock, perfNow } from '../../core/logging/perf.js';
import { paginationService } from '../../core/logs/PaginationService.js';
import { LOG_WINDOW_SIZE, MERGE_PROGRESS_THROTTLE_MS } from '../../shared/const.js';

type Handler = (msg: W2H, api: BridgeAPI) => Promise<void> | void;

export type MergeReporter = {
  onStage: (text: string, kind?: 'start' | 'done' | 'info') => void;
  onProgress: (args: {
    inc?: number;
    done?: number;
    total?: number;
    active?: boolean;
    reset?: boolean;
  }) => void;
};

export type BridgeOptions = {
  /** UI가 보낸 로그를 호스트 채널/출력에 연결하고 싶을 때 */
  onUiLog?: (args: {
    level: 'debug' | 'info' | 'warn' | 'error';
    text: string;
    source?: string;
    line: string;
  }) => void;
  /** 사용자 환경설정 읽기 (필요 시 주입) */
  readUserPrefs?: () => Promise<any>;
  /** 사용자 환경설정 저장 (필요 시 주입) */
  writeUserPrefs?: (patch: any) => Promise<void>;
};

export class HostWebviewBridge {
  private log = getLogger('bridge');
  // 여러 리스너를 타입별로 보유 (동시 request의 ack/error 핸들러 지원)
  private handlers = new Map<string, Set<Handler>>();
  private pendings = new Map<string, AbortController>(); // abortKey -> controller
  private seq = 0;
  private kickedOnce = false; // 초기 리프레시 신호를 중복 발사하지 않도록 가드
  // ── Search buffer (host-held) ────────────────────────────────────────
  private searchHits: { idx: number; text: string }[] = [];
  // ── 로그 스로틀(반복 노이즈 억제) ─────────────────────────────────────
  private lastLogTs = new Map<string, number>();
  private lastPayload = new Map<string, string>();
  private shouldLog(key: string, ms = 400, payload?: string) {
    const now = Date.now();
    const last = this.lastLogTs.get(key) ?? -Infinity;
    if (payload && this.lastPayload.get(key) === payload) return false;
    if (now - last < ms) return false;
    this.lastLogTs.set(key, now);
    if (payload) this.lastPayload.set(key, payload);
    return true;
  }

  // ── 진행률 스로틀(100ms) ──────────────────────────────────────────────
  private progressLatest: { done?: number; total?: number; active?: boolean } = {};
  private progressIncAcc = 0; // 100ms 동안 inc 누적
  private progressResetPending = false; // reset 1회 패스
  private progressLastSentKey = '';
  private progressTimer?: NodeJS.Timeout;
  private startProgressTicker() {
    if (this.progressTimer) return;
    this.progressTimer = setInterval(() => {
      const k = `${this.progressLatest.done ?? ''}|${this.progressLatest.total ?? ''}|${this.progressLatest.active ?? ''}|${this.progressIncAcc}|${this.progressResetPending ? 'R' : ''}`;
      if (k === this.progressLastSentKey) return; // 변화 없음
      this.progressLastSentKey = k;
      const payload: any = { ...this.progressLatest };
      if (this.progressIncAcc) payload.inc = this.progressIncAcc;
      if (this.progressResetPending) payload.reset = true;
      this.send({ v: 1, type: 'merge.progress', payload } as H2W);
      // 전송 후 누적/플래그 초기화
      this.progressIncAcc = 0;
      this.progressResetPending = false;
      if (this.progressLatest.active === false) {
        clearInterval(this.progressTimer!);
        this.progressTimer = undefined;
      }
    }, MERGE_PROGRESS_THROTTLE_MS);
  }

  constructor(
    private readonly host: vscode.WebviewView | vscode.WebviewPanel,
    private readonly options: BridgeOptions = {},
  ) {}

  @measure()
  start() {
    this.host.webview.onDidReceiveMessage(async (raw: any) => {
      await measureBlock('host.bridge.onMessage', async () => {
        const msg = this.validateIncoming(raw);
        if (!msg) return;

        // ── 웹뷰가 준비 신호를 보낼 수 있는 경우(선행 핸드셰이크) ──
        if (msg.type === 'viewer.ready') {
          this.kickIfReady('viewer.ready');
          return;
        }

        // ── UI 로그 브리지: webview → host ───────────────────────────────
        // NOTE: 브리지가 모든 H2W를 전담해 중복 송신을 방지
        if (msg.type === 'ui.log') {
          const lvl = String(msg?.payload?.level ?? 'info').toLowerCase() as
            | 'debug'
            | 'info'
            | 'warn'
            | 'error';
          const text = String(msg?.payload?.text ?? '');
          const source = String(msg?.payload?.source ?? 'ui');
          const line = `[${lvl}] [${source}] ${text}`;
          try {
            switch (lvl) {
              case 'debug':
                this.log.debug?.(line);
                break;
              case 'warn':
                this.log.warn(line);
                break;
              case 'error':
                this.log.error(line);
                break;
              default:
                this.log.info(line);
            }
            this.options.onUiLog?.({ level: lvl, text, source, line });
          } catch {}
          return;
        }

        // ── 온디맨드 페이지 로딩: 웹뷰가 스크롤 범위를 요청 ──
        if (msg.type === 'logs.page.request') {
          try {
            const { startIdx, endIdx } = msg.payload || {};
            const s = Number(startIdx) || 1;
            const e = Number(endIdx) || s;
            if (this.shouldLog('page.req', 300, `${s}-${e}`)) {
              this.log.debug?.(
                `bridge: logs.page.request ${s}-${e} filterActive=${paginationService.isFilterActive()}`,
              );
            }
            const logs = await paginationService.readRangeByIdx(s, e); // 내부에서 필터 적용 분기
            // 현재 pagination 버전을 함께 내려, 웹뷰가 세션 불일치를 걸러낼 수 있게 한다.
            const version = paginationService.getVersion();
            this.send({
              v: 1,
              type: 'logs.page.response',
              payload: { startIdx: s, endIdx: e, logs, version },
            } as any);
            if (this.shouldLog('page.resp', 300, `${s}-${e}:${logs.length}`)) {
              this.log.debug?.(
                `bridge: logs.page.response ${s}-${e} len=${logs.length} v=${version}`,
              );
            }
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

        // ── 서버측 필터 설정(단일 API: null=해제) ──────────────────────────
        if (msg.type === 'logs.filter.set') {
          try {
            const warm = paginationService.isWarmupActive();
            const filter = (msg.payload?.filter ?? null) as LogFilter | null;
            this.log.info(`bridge: logs.filter.set ${JSON.stringify(filter)}`);
            paginationService.setFilter(filter);
            // ⬇️ 중요: 필터 적용 후의 총계(필터 미적용이면 전체 총계)를 기준으로 total/윈도우 계산
            const total = (await paginationService.getFilteredTotal()) ?? 0;
            const startIdx = Math.max(1, total - LOG_WINDOW_SIZE + 1);
            const endIdx = Math.max(1, total);
            const head = total > 0 ? await paginationService.readRangeByIdx(startIdx, endIdx) : [];
            this.send({
              v: 1,
              type: 'logs.batch',
              payload: {
                logs: head,
                total,
                seq: ++this.seq,
                version: paginationService.getVersion(),
              },
            } as any);
            // 상태도 함께 브로드캐스트
            this.send({
              v: 1,
              type: 'logs.state',
              payload: {
                total,
                version: paginationService.getVersion(),
                warm,
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
                warm,
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
        // ──────────────────────────────────────────────

        // ── 전체 검색(노트패드++ 스타일): Enter 시 실행 ───────────────
        if (msg.type === 'search.query') {
          try {
            const q: string = String(msg?.payload?.q || '').trim();
            const regex = !!msg?.payload?.regex;
            const range = msg?.payload?.range as [number, number] | undefined;
            const top = typeof msg?.payload?.top === 'number' ? msg.payload.top : undefined;

            this.log.info(
              `bridge: search.query q="${q}" regex=${regex} range=${range ?? '-'} top=${top ?? '-'}`,
            );
            // 단일 패스 검색으로 변경(필터 공간 기준)
            this.searchHits = await paginationService.searchAll(q, { regex, range, top });

            this.log.info(`bridge: search.results hits=${this.searchHits.length}`);
            this.send({
              v: 1,
              type: 'search.results',
              payload: { hits: this.searchHits, q },
            } as any);
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

        // ── 새로운 메시지 타입들 처리 ──────────────────────────────────────
        const anyMsg = msg as any;
        if (anyMsg.type === 'prefs.load') {
          try {
            if (!this.options.readUserPrefs) throw new Error('readUserPrefs not provided');
            const prefs = await this.options.readUserPrefs();
            this.send({ v: 1, type: 'prefs.data', payload: { prefs } } as any);
          } catch (e) {
            this.sendError(e, anyMsg.id);
          }
          return;
        }

        if (anyMsg.type === 'prefs.save') {
          try {
            if (!this.options.writeUserPrefs) throw new Error('writeUserPrefs not provided');
            const patch = anyMsg.payload?.prefs ?? {};
            await this.options.writeUserPrefs(patch);
            this.send({ v: 1, type: 'ack', payload: { inReplyTo: anyMsg.id } } as any);
          } catch (e) {
            this.sendError(e, anyMsg.id);
          }
          return;
        }

        if (anyMsg.type === 'logs.search') {
          try {
            const { query, caseSensitive = false, regex = false, abortKey } = anyMsg.payload || {};
            if (!query || typeof query !== 'string') {
              throw new Error('Invalid search request: query required');
            }

            const controller = new AbortController();
            if (abortKey) this.registerAbort(abortKey, controller);
            // 정규식 사전 컴파일(실패 시 즉시 에러 반환)
            let re: RegExp | null = null;
            if (regex) {
              try {
                // 존재 여부만 보면 되므로 'g' 불필요. 대소문자 옵션은 i 플래그로 처리.
                re = new RegExp(query, caseSensitive ? '' : 'i');
              } catch (err) {
                this.send({
                  v: 1,
                  type: 'error',
                  payload: { code: 'INVALID_REGEX', message: String(err), inReplyTo: anyMsg.id },
                } as any);
                return;
              }
            }

            // 검색 결과 수집 (간단 구현)
            const hits: { idx: number; text: string }[] = [];
            const total = (await paginationService.getFilteredTotal()) || 0;

            for (let idx = 1; idx <= total && !controller.signal.aborted; idx++) {
              try {
                const page = await paginationService.readRangeByIdx(idx, idx);
                if (page.length > 0) {
                  const log = page[0];
                  const rawLevel = (log as any)?.level;
                  const rawText = (log as any)?.text ?? '';
                  const text =
                    typeof rawLevel === 'string' && rawLevel.length > 0
                      ? `${rawLevel} ${rawText}`
                      : String(rawText);

                  if (regex) {
                    if (re!.test(text)) {
                      hits.push({ idx, text });
                    }
                  } else {
                    const hay = caseSensitive ? text : text.toLowerCase();
                    const needle = caseSensitive ? query : query.toLowerCase();
                    if (hay.includes(needle)) {
                      hits.push({ idx, text });
                    }
                  }
                }
              } catch {
                // 개별 읽기 실패는 무시
              }
            }

            if (!controller.signal.aborted) {
              this.searchHits = hits;
              this.send({
                v: 1,
                type: 'logs.search.result',
                payload: { hits, total: hits.length },
              } as any);
            }
          } catch (e: any) {
            const message = e?.message || String(e);
            this.send({
              v: 1,
              type: 'error',
              payload: { code: 'SEARCH_ERROR', message, inReplyTo: anyMsg.id },
            } as any);
          }
          return;
        }

        if (anyMsg.type === 'logs.bookmarks.load') {
          try {
            // 북마크는 웹뷰 로컬 스토리지에 저장되므로 호스트는 빈 응답
            this.send({ v: 1, type: 'logs.bookmarks.data', payload: { bookmarks: {} } } as any);
          } catch (e) {
            this.sendError(e, anyMsg.id);
          }
          return;
        }

        if (anyMsg.type === 'logs.bookmarks.save') {
          try {
            this.send({ v: 1, type: 'ack', payload: { inReplyTo: anyMsg.id } } as any);
          } catch (e) {
            this.sendError(e, anyMsg.id);
          }
          return;
        }

        if (anyMsg.type === 'logs.bookmarks.toggle') {
          try {
            this.send({ v: 1, type: 'ack', payload: { inReplyTo: anyMsg.id } } as any);
          } catch (e) {
            this.sendError(e, anyMsg.id);
          }
          return;
        }

        if (anyMsg.type === 'logs.bookmarks.clear') {
          try {
            this.send({ v: 1, type: 'ack', payload: { inReplyTo: anyMsg.id } } as any);
          } catch (e) {
            this.sendError(e, anyMsg.id);
          }
          return;
        }

        if (anyMsg.type === 'logs.follow') {
          try {
            const { enabled } = anyMsg.payload || {};
            // 팔로우 모드 상태 저장 (필요시 구현)
            this.log.info(`Follow mode ${enabled ? 'enabled' : 'disabled'}`);
            this.send({ v: 1, type: 'ack', payload: { inReplyTo: anyMsg.id } } as any);
          } catch (e) {
            this.sendError(e, anyMsg.id);
          }
          return;
        }

        if (anyMsg.type === 'logs.jump') {
          try {
            const { idx, mode = 'center' } = anyMsg.payload || {};
            if (typeof idx !== 'number') {
              throw new Error('Invalid jump request: idx required');
            }

            const total = (await paginationService.getFilteredTotal()) || 0;
            if (idx < 1 || idx > total) {
              throw new Error(`Index out of range: ${idx}, total: ${total}`);
            }

            let startIdx: number, endIdx: number;
            const windowSize = LOG_WINDOW_SIZE;

            switch (mode) {
              case 'top':
                startIdx = Math.max(1, idx);
                endIdx = Math.min(total, startIdx + windowSize - 1);
                break;
              case 'bottom':
                endIdx = Math.min(total, idx);
                startIdx = Math.max(1, endIdx - windowSize + 1);
                break;
              case 'center':
              default: {
                const halfWindow = Math.floor(windowSize / 2);
                startIdx = Math.max(1, idx - halfWindow);
                endIdx = Math.min(total, startIdx + windowSize - 1);
                if (endIdx - startIdx + 1 < windowSize) {
                  startIdx = Math.max(1, endIdx - windowSize + 1);
                }
                break;
              }
            }

            const page = await paginationService.readRangeByIdx(startIdx, endIdx);
            const version = paginationService.getVersion();
            this.send({
              v: 1,
              type: 'logs.page.response',
              payload: { startIdx, endIdx, logs: page, version },
            } as any);
          } catch (e) {
            this.sendError(e, anyMsg.id);
          }
          return;
        }

        if (anyMsg.type === 'logs.capacity') {
          try {
            const { capacity } = anyMsg.payload || {};
            if (typeof capacity !== 'number' || capacity < 1) {
              throw new Error('Invalid capacity: must be positive number');
            }

            // 용량 설정은 웹뷰에서만 사용하므로 ack만
            this.log.info(`Log capacity set to ${capacity}`);
            this.send({ v: 1, type: 'ack', payload: { inReplyTo: anyMsg.id } } as any);
          } catch (e) {
            this.sendError(e, anyMsg.id);
          }
          return;
        }

        const handlers = this.handlers.get(msg.type);
        if (!handlers || handlers.size === 0) return this.warnUnknown(msg.type);
        try {
          await Promise.all(Array.from(handlers).map((h) => h(msg, this.api())));
        } catch (e) {
          this.sendError(e, msg.id);
        }
      }); // measureBlock
    });

    // 패널이 막 열렸을 때도 한 번 킥 — 최신 뷰어는 자체적으로 요청을 시작하지 않으므로
    // 다음 틱에 상태/리프레시 신호를 푸시한다.
    setTimeout(() => this.kickIfReady('bridge.start'), 0);
  }

  on(type: W2H['type'], handler: Handler) {
    const set = this.handlers.get(type) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(type, set);
    return {
      dispose: () => {
        const s = this.handlers.get(type);
        if (!s) return;
        s.delete(handler);
        if (s.size === 0) this.handlers.delete(type);
      },
    };
  }

  /** 브리지에서만 사용: 안전하게 웹뷰로 송신 */
  private send(m: H2W) {
    // 내부 전송 시작/끝 로그는 노이즈가 많아 제거
    if (!globalProfiler.isOn()) {
      this.host.webview.postMessage(m);
      return;
    }
    const t0 = perfNow();
    try {
      this.host.webview.postMessage(m);
    } finally {
      globalProfiler.recordFunctionCall('bridge.send', t0, perfNow() - t0);
    }
  }

  /** 외부(패널 매니저 등)에서 단방향 알림을 보낼 때 사용하는 공개 API.
   *  내부 계측/스로틀은 private send를 그대로 사용해 일관성을 유지한다. */
  public notify<T extends H2W>(msg: T): void {
    // 단방향이므로 ack를 기다리지 않는다.
    this.send(msg);
  }

  @measure()
  request<T extends H2W>(msg: Omit<T, 'id'>): Promise<unknown> {
    const impl = () =>
      new Promise((resolve, reject) => {
        const id = `req_${Date.now()}_${++this.seq}`;
        const cleanup = (...ds: Array<{ dispose: () => void }>) => {
          ds.forEach((d) => {
            try {
              d.dispose();
            } catch {}
          });
        };
        const dAck = this.on('ack' as any, (ack: any) => {
          if (ack?.payload?.inReplyTo === id) {
            cleanup(dAck, dErr);
            resolve(ack.payload);
          }
        });
        const dErr = this.on('error' as any, (err: any) => {
          if (err?.payload?.inReplyTo === id) {
            cleanup(dAck, dErr);
            // 에러 페이로드를 그대로 전달(reject)
            reject(err.payload);
          }
        });
        this.send({ ...(msg as any), id } as any);
      });
    return globalProfiler.isOn()
      ? globalProfiler.measureFunction('host.bridge.request', impl)
      : impl();
  }

  @measure()
  registerAbort(abortKey: string, controller: AbortController) {
    this.log.debug('[debug] HostWebviewBridge registerAbort: start');
    this.abort(abortKey); // 기존 있으면 정리
    this.pendings.set(abortKey, controller);
    this.log.debug('[debug] HostWebviewBridge registerAbort: end');
  }

  @measure()
  abort(abortKey: string) {
    this.log.debug('[debug] HostWebviewBridge abort: start');
    const c = this.pendings.get(abortKey);
    if (c) {
      c.abort();
      this.pendings.delete(abortKey);
    }
    this.log.debug('[debug] HostWebviewBridge abort: end');
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
    // payload는 없을 수도 있음(viewer.ready 등)
    if (raw.payload !== undefined && typeof raw.payload !== 'object') return null;
    return raw as W2H;
  }

  private warnUnknown(type: string) {
    // 알 수 없는 메시지는 초당 1회 수준으로만 경고
    if (this.shouldLog('unknown', 1000, type)) this.log.warn(`unknown webview message: ${type}`);
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
  @measure()
  private async kickIfReady(origin: 'bridge.start' | 'viewer.ready') {
    try {
      const warm = paginationService.isWarmupActive();
      // 필터 활성 시에는 필터 총계를, 아니면 전체 총계를 보낸다.
      const filteredTotal = await paginationService.getFilteredTotal();
      const total = typeof filteredTotal === 'number'
        ? filteredTotal
        : (warm ? paginationService.getWarmTotal() : paginationService.getFileTotal());
      const version = paginationService.getVersion();
      const manifestDir = paginationService.getManifestDir();

      // 상태는 매번 보내도 무방(웹뷰가 최신값으로 덮어씀)
      this.log.info(
        `bridge: kickIfReady origin=${origin} warm=${warm} total=${typeof total === 'number' ? total : 'unknown'} version=${version} manifest=${manifestDir ?? '-'}`,
      );
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
      }
    } catch (e: any) {
      this.log.warn(`bridge: kickIfReady failed: ${e?.message || e}`);
    }
  }

  /** 외부(예: extensionPanel/manager)에서 사용할 병합 리포터 생성기
   *  - onStage/onProgress만 호출하면 브리지가 알아서 웹뷰로 전파(중복 제거/스로틀)
   */
  createMergeReporter(): MergeReporter {
    return {
      onStage: (text, kind) => {
        try {
          const payload = { text: String(text || ''), kind: kind ?? 'info', at: Date.now() };
          this.send({ v: 1, type: 'merge.stage', payload } as H2W);
          // 상태 텍스트는 즉시 전달
        } catch (e) {
          this.log.debug?.(`bridge.stage.send: ${e}`);
        }
      },
      onProgress: (args) => {
        try {
          // 최신값만 보관 → 100ms마다 변화 시에만 송신
          if (typeof args.inc === 'number') this.progressIncAcc += Math.max(0, args.inc | 0);
          if (typeof args.done === 'number') this.progressLatest.done = Math.max(0, args.done | 0);
          if (typeof args.total === 'number')
            this.progressLatest.total = Math.max(0, args.total | 0);
          if (typeof args.active === 'boolean') this.progressLatest.active = args.active;
          if (args.reset === true) this.progressResetPending = true;
          this.startProgressTicker();
        } catch (e) {
          this.log.debug?.(`bridge.progress.defer: ${e}`);
        }
      },
    };
  }

  /** 리스너/대기중 컨트롤러 정리용 */
  @measure()
  dispose() {
    try {
      this.pendings.forEach((c) => c.abort());
    } finally {
      this.pendings.clear();
      this.handlers.clear();
      this.kickedOnce = false;
      // ⬇️ 진행률 타이머 정리 (누수 방지)
      if (this.progressTimer) {
        clearInterval(this.progressTimer);
        this.progressTimer = undefined;
      }
    }
  }
}

export type BridgeAPI = {
  send: <T extends H2W>(msg: T) => void;
  request: <T extends H2W>(msg: Omit<T, 'id'>) => Promise<unknown>;
  registerAbort: (abortKey: string, controller: AbortController) => void;
  abort: (abortKey: string) => void;
};
