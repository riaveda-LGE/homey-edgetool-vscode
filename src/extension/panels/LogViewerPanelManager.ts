// src/extension/panels/LogViewerPanelManager.ts
// === src/extension/panels/LogViewerPanelManager.ts ===
import * as path from 'path';
import * as vscode from 'vscode';

import {
  getCurrentWorkspacePathFs,
  readLogViewerPrefs,
  writeLogViewerPrefs,
} from '../../core/config/userdata.js';
import { readParserWhitelistGlobs } from '../../core/config/userdata.js';
import { readParserConfigJson } from '../../core/config/userdata.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { globalProfiler, measure, perfNow } from '../../core/logging/perf.js';
import { paginationService } from '../../core/logs/PaginationService.js';
import { LogSessionManager } from '../../core/sessions/LogSessionManager.js';
import { MERGED_DIR_NAME, RAW_DIR_NAME } from '../../shared/const.js';
import type { MergeSavedInfo } from '../../shared/ipc/messages.js';
import { HostWebviewBridge } from '../messaging/hostWebviewBridge.js';

export class LogViewerPanelManager {
  private log = getLogger('LogViewerPanelManager');
  private panel?: vscode.WebviewPanel;
  private bridge?: HostWebviewBridge;
  private session?: LogSessionManager;
  private memTimer?: NodeJS.Timeout;
  private memPeriodMs = 60_000; // 기본: 느리게(완료 후)
  private readonly MEM_FAST_MS = 2_000;
  private readonly MEM_SLOW_MS = 60_000;

  private mode: 'idle' | 'realtime' | 'filemerge' = 'idle';
  private initialSent = false;

  // ── 진행률 로그 샘플링 상태 ─────────────────────────────────────────────
  private progAcc = 0; // inc 누적(라인 수)
  private progDoneAcc = 0; // 진행 누적(라인 수)
  private progTotal?: number; // 총 라인 수
  private progLastLogMs = 0; // 마지막 로그 시각(ms)
  private readonly PROG_LINES_THRESHOLD = 1000; // 누적 라인 임계치
  private readonly PROG_LOG_INTERVAL_MS = 800; // 최소 간격(ms)
  // ──────────────────────────────────────────────────────────────────────
  // 전송 로그 샘플링
  private lastBatchLogMs = 0;
  private lastPageLogMs = 0;
  private readonly SEND_LOG_INTERVAL_MS = 800;

  constructor(
    private context: vscode.ExtensionContext,
    private extensionUri: vscode.Uri,
  ) {}

  dispose() {
    // quiet
    try {
      this.session?.dispose();
    } catch {}
    this.session = undefined;
    if (this.panel) this.panel.dispose();
    // quiet
  }

  /** 메모리 샘플 1회 전송 */
  private _postMemOnce() {
    try {
      const m = process.memoryUsage();
      const rssMB = Math.round(m.rss / 1048576);
      const heapUsedMB = Math.round(m.heapUsed / 1048576);
      const externalMB = Math.round(m.external / 1048576);
      const arrayBuffersMB = Math.round(((m as any).arrayBuffers || 0) / 1048576);
      this._send('memory.usage', {
        rssMB,
        heapUsedMB,
        externalMB,
        arrayBuffersMB,
        ts: Date.now(),
      });
    } catch {
      // ignore
    }
  }

  /** 샘플 주기 전환(즉시 1회 송신 포함) */
  private _setMemPeriod(ms: number) {
    if (this.memPeriodMs === ms) return;
    if (this.memTimer) clearInterval(this.memTimer);
    this.memPeriodMs = ms;
    this._postMemOnce();
    this.memTimer = setInterval(() => this._postMemOnce(), this.memPeriodMs);
  }
  @measure()
  async handleHomeyLoggingCommand() {
    const already = !!this.panel;
    // quiet

    // (중요) 뷰어 오픈 시 raw 삭제 금지 — 초기화는 워크스페이스 설정/보장 단계에서만 수행

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'homey-log-viewer',
        'Homey Log Viewer',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          // 정식 UI 리소스만 노출
          localResourceRoots: [
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webviewers', 'log-viewer'),
          ],
        },
      );
      this.panel.onDidDispose(() => {
        // quiet
        try {
          this.bridge?.dispose?.();
        } catch {}
        this.bridge = undefined;
        this.panel = undefined;
        if (this.memTimer) {
          clearInterval(this.memTimer);
          this.memTimer = undefined;
        }
      });

      // 정식 Log Viewer UI 로드
      const uiRoot = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webviewers', 'log-viewer');
      // quiet
      this.panel.webview.html = await this._getHtmlFromFiles(this.panel.webview, uiRoot);
      // quiet

      // 메시지 라우팅을 bridge로 일원화
      this.bridge = new HostWebviewBridge(this.panel, {
        onUiLog: ({ level, text, source, line }) => {},
        readUserPrefs: async () => {
          // quiet
          const prefs = await readLogViewerPrefs(this.context);
          // quiet
          return prefs;
        },
        writeUserPrefs: async (patch: any) => {
          await writeLogViewerPrefs(this.context, patch ?? {});
          // quiet
        },
      });
      this.bridge.start();
      // ── Host 메모리 샘플러: 기본은 느리게(완료 주기) 시작 ──────────────
      if (this.memTimer) { clearInterval(this.memTimer); this.memTimer = undefined; }
      this._setMemPeriod(this.MEM_SLOW_MS);
      // quiet
      await vscode.commands.executeCommand('homey.logging.openViewer');
    }
    this.panel.reveal(undefined, true);
    // quiet
  }

  /** 실시간 세션 시작: 라인 들어오는 대로 즉시 UI 전송 */
  @measure()
  async startRealtime(filter?: string) {
    // quiet
    if (!this.panel) await this.handleHomeyLoggingCommand();
    this.mode = 'realtime';
    this.initialSent = true; // 실시간은 제한 없음
    // quiet

    this.session?.dispose();
    this.session = new LogSessionManager({ id: 'default', type: 'adb', timeoutMs: 15000 });
    // 실시간 모드는 병합이 없으므로 느리게
+   this._setMemPeriod(this.MEM_SLOW_MS);

    await this.session.startRealtimeSession({
      filter,
      onBatch: (logs) => {
        // quiet
        this._send('logs.batch', { logs });
      },
      onMetrics: (m) => {
        this._send('metrics.update', m);
      },
    });
    // quiet
  }

  /** 파일 병합 세션 시작: 최초 최신 LOG_WINDOW_SIZE만 보내고, 이후는 스크롤 요청에 따른 페이지 읽기 */
  @measure()
  async startFileMerge(dir: string) {
    // quiet
    if (!this.panel) await this.handleHomeyLoggingCommand();
    // 브리지 진행률 리포터(중앙 스로틀)
    const reporter = this.bridge?.createMergeReporter();
    this.mode = 'filemerge';
    this.initialSent = false;
    // quiet

    // 워크스페이스 준비는 확장 활성화/변경 단계에서 이미 보장됨

    // 🔒 샘플링 상태 리셋 (권장)
    this.progAcc = 0;
    this.progDoneAcc = 0;
    this.progTotal = undefined;
    this.progLastLogMs = 0;

    // ✅ 병합 결과 저장 위치를 workspace/raw/merge_log 로 고정 (준비 완료 기준)
    const wsRoot = await this._resolveWorkspaceRoot();
    const indexOutDir = wsRoot ? path.join(wsRoot, RAW_DIR_NAME, MERGED_DIR_NAME) : undefined;
    if (!wsRoot) {
      this.log.warn('merge: no workspace folder, fallback to default outDir');
    }

    this.session?.dispose();
    this.session = new LogSessionManager(undefined);
    // 병합 시작: 빠르게 전환
    this._setMemPeriod(this.MEM_FAST_MS);

    // ⬇️ 파서 설정(.config/custom_log_parser.json)에서 files 화이트리스트 추출
    let whitelistGlobs: string[] | undefined;
    try {
      whitelistGlobs = await readParserWhitelistGlobs(this.context);
      // quiet
    } catch (e: any) {
      this.log.warn(`merge: failed to read parser whitelist globs (${e?.message ?? e})`);
    }

    // ⬇️ 파서 설정 전체 읽기
    let parserConfig: any;
    try {
      parserConfig = await readParserConfigJson(this.context);
      // quiet
    } catch (e: any) {
      this.log.warn(`merge: failed to read parser config (${e?.message ?? e})`);
    }

    await this.session.startFileMergeSession({
      dir,
      indexOutDir,
      whitelistGlobs,
      parserConfig,
      onBatch: (logs, total, seq) => {
        if (this.initialSent) return;
        // quiet
        // 초기 배치에도 현재 pagination 버전을 함께 전달(웹뷰 버전 동기화)
        const ver = paginationService.getVersion();
        this._send('logs.batch', { logs, total, seq, version: ver });
        this.initialSent = true;
      },
      onSaved: (info: MergeSavedInfo) => {
        // quiet
        this._send('logmerge.saved', info);
      },
      onMetrics: (m) => this._send('metrics.update', m),

      // 정식 병합(T1) 완료 → UI 하드리프레시
      onRefresh: ({
        total,
        version,
        warm,
      }: {
        total?: number;
        version?: number;
        warm?: boolean;
      }) => {
        // warm=true면 “정식 병합 스킵(메모리 모드 완료)”을 명시로 알림
        this._send('logs.refresh', {
          reason: 'full-reindex',
          total,
          version,
          warm: !!warm,
        });
        // 정식 병합 완료(스킵 포함): 느리게 전환
        this._setMemPeriod(this.MEM_SLOW_MS);
      },

      // ── 진행률: 로그는 샘플링해서 출력, 메시지 전달은 매번 유지 ─────────
      onProgress: (p) => {
        const { inc, total, done, active, reset } = p ?? {};
        // 중앙 스로틀(브리지)로 전달
        reporter?.onProgress?.({ inc, total, done, active, reset });

        // ─ 로그 노이즈 억제 ─
        const now = Date.now();
        if (active) {
          // 병합 중: 빠르게
          this._setMemPeriod(this.MEM_FAST_MS);
          if (typeof total === 'number') this.progTotal = total;
          const add = typeof inc === 'number' ? inc : 0;
          this.progAcc += add;
          this.progDoneAcc += add;

          // 조건: 누적 라인 임계 + 최소 간격 충족 시에만 1줄 로그
          if (
            this.progAcc >= this.PROG_LINES_THRESHOLD &&
            now - this.progLastLogMs >= this.PROG_LOG_INTERVAL_MS
          ) {
            // quiet
            this.progAcc = 0;
            this.progLastLogMs = now;
          }
        } else {
          // 완료 시에는 정확 수치 1회만 출력
          // 병합 종료: 느리게
          this._setMemPeriod(this.MEM_SLOW_MS);
          if (typeof total === 'number') this.progTotal = total;
          if (typeof done === 'number') this.progDoneAcc = done;
          // quiet
          // 상태 초기화
          this.progAcc = 0;
          this.progDoneAcc = 0;
          this.progTotal = undefined;
          this.progLastLogMs = 0;
        }
      },
      // stage 신호 중 "정식 병합 스킵: ..." 완료를 감지하면 warm refresh를 보강 전송
      onStage: (text, kind) => {
        reporter?.onStage?.(text, kind);
        this._handleStageAndMaybeWarmRefresh(text, kind);
      },
    });
    this.log.debug('[debug] LogViewerPanelManager startFileMerge: end');
  }

  /**
   * 병합 단계(stage) 신호를 UI로 중계하면서, "스킵 완료"를 감지하면
   * logs.refresh(warm=true)도 함께 보내 사후 처리를 통일한다.
   * - 과거에는 Manager 경로에서 스킵을 조기 결정하여 완료 신호가 누락될 수 있었음.
   * - 이제는 mergeDirectory에서 스킵을 결정하고 stage 'done'을 보내지만,
   *   혹시 호출자 레이어에서 refresh를 놓쳐도 이 레이어가 보강한다.
   */
  private _handleStageAndMaybeWarmRefresh(text?: string, kind?: 'start' | 'done' | 'info') {
    const t = String(text || '');
    // 완료 시그널이면서 "정식 병합 스킵" 텍스트를 포함하면 warm 리프레시를 보낸다.
    if (kind === 'done' && /정식\s*병합\s*스킵/.test(t)) {
      const total = paginationService.getWarmTotal();
      const version = paginationService.getVersion();
      this.log.info(
        `viewer: warm-skip detected → sending logs.refresh(warm=true) total=${total} v=${version}`,
      );
      this._send('logs.refresh', { reason: 'full-reindex', total, version, warm: true });
      // 완료로 간주 → 느리게
      this._setMemPeriod(this.MEM_SLOW_MS);
    }
  }

  @measure()
  stop() {
    this.log.debug('[debug] LogViewerPanelManager stop: start');
    this.session?.stopAll();
    this.log.info('Logging stopped');
    this.log.debug('[debug] LogViewerPanelManager stop: end');
  }

  private _send<T extends string>(type: T, payload: any) {
    const profOn = globalProfiler.isOn();
    const t0 = profOn ? perfNow() : 0;
    try {
      if (type === 'logs.batch') {
        const now = Date.now();
        if (now - this.lastBatchLogMs >= this.SEND_LOG_INTERVAL_MS) {
          const len = Array.isArray(payload?.logs) ? payload.logs.length : 0;
          const total = payload?.total;
          const seq = payload?.seq;
          const ver = payload?.version;
          this.log.debug(
            `[debug] host→ui: ${type} (len=${len}, total=${total ?? ''}, seq=${seq ?? ''}, v=${ver ?? ''})`,
          );
          this.lastBatchLogMs = now;
        }
      } else if (type === 'logs.page.response') {
        const now = Date.now();
        if (now - this.lastPageLogMs >= this.SEND_LOG_INTERVAL_MS) {
          const len = Array.isArray(payload?.logs) ? payload.logs.length : 0;
          this.log.debug(
            `[debug] host→ui: ${type} (${payload?.startIdx}-${payload?.endIdx}, len=${len})`,
          );
          this.lastPageLogMs = now;
        }
      } else if (type === 'logs.refresh') {
        this.log.debug(
          `[debug] host→ui: logs.refresh (total=${payload?.total ?? ''}, v=${payload?.version ?? ''})`,
        );
      }
      this.bridge?.notify({ v: 1, type, payload } as any);
    } catch {
      // no-op: 전송 실패는 상위 브리지에서 추가 로깅됨
    } finally {
      if (profOn) globalProfiler.recordFunctionCall('viewer._send', t0, perfNow() - t0);
    }
  }

  // ─────────────────────────────────────────────────────────
  // Workspace helpers — userdata 우선 → 표준 VS Code → fallback
  // ─────────────────────────────────────────────────────────
  @measure()
  private async _resolveWorkspaceRoot(): Promise<string | undefined> {
    // 1) userdata 기반
    try {
      const p = await getCurrentWorkspacePathFs(this.context);
      if (p && p.trim()) {
        this.log.info(`viewer: workspace root from userdata=${p}`);
        return p.trim();
      }
    } catch {}

    // 2) VS Code 표준 워크스페이스
    const ws = vscode.workspace.workspaceFolders;
    if (ws && ws.length > 0) {
      const p = ws[0].uri.fsPath;
      this.log.info(`viewer: workspace root from workspaceFolders=${p}`);
      return p;
    }

    // 3) 사용자 설정(homeyEdgeTool.workspaceRoot)
    const cfg = vscode.workspace.getConfiguration('homeyEdgeTool');
    const cfgRoot = cfg.get<string>('workspaceRoot');
    if (cfgRoot && cfgRoot.trim()) {
      this.log.info(`viewer: workspace root from config=${cfgRoot}`);
      return cfgRoot.trim();
    }

    // 4) 과거 세션 잔존 값
    const last = this.context.workspaceState.get<string>('lastWorkspaceRoot');
    if (last && last.trim()) {
      this.log.info(`viewer: workspace root from workspaceState=${last}`);
      return last.trim();
    }

    return undefined;
  }

  // ─────────────────────────────────────────────────────────
  // 정식 UI HTML 로드 (CSP/nonce 및 리소스 경로 재작성)
  // ─────────────────────────────────────────────────────────
  @measure()
  private _randomNonce(len = 32) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < len; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
  }

  @measure()
  private async _getHtmlFromFiles(webview: vscode.Webview, root: vscode.Uri) {
    try {
      const indexHtml = vscode.Uri.joinPath(root, 'index.html');
      const htmlRaw = await vscode.workspace.fs.readFile(indexHtml);
      let html = new TextDecoder('utf-8').decode(htmlRaw);

      const nonce = this._randomNonce();

      // 1) placeholder 치환(있으면)
      html = html.replace(/%CSP_SOURCE%/g, webview.cspSource);
      html = html.replace(/%NONCE%/g, nonce);

      // 2) 리소스 경로 재작성 (script/link/img - src/href)
      const ATTR_RE = /(<(script|link|img)\b[^>]*?\s(?:src|href)=)(['"])([^'"]+)\3/gi;
      html = html.replace(ATTR_RE, (_m, p1, _tag, q, url) => {
        const abs =
          /^(?:https?:|data:|blob:|vscode-)/i.test(url) ||
          url.startsWith('#') ||
          url.startsWith('//');
        if (abs) return `${p1}${q}${url}${q}`;
        const rewritten = webview.asWebviewUri(vscode.Uri.joinPath(root, url)).toString();
        return `${p1}${q}${rewritten}${q}`;
      });

      // 3) nonce가 없는 script 태그에 nonce 부여
      html = html.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);

      // 4) meta CSP가 없다면 최소 CSP 주입
      if (!/Content-Security-Policy/i.test(html)) {
        const cspMeta = `
          <meta http-equiv="Content-Security-Policy"
            content="
              default-src 'none';
              img-src ${webview.cspSource} blob: data:;
              style-src ${webview.cspSource} 'unsafe-inline';
              font-src ${webview.cspSource};
              script-src 'nonce-${nonce}';
              connect-src ${webview.cspSource} https:;
            ">
        `;
        html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${cspMeta}`);
      }

      return html;
    } catch (e) {
      this.log.error('[LogViewerPanelManager] UI load failed:', e);
      this.log.error('viewer: UI load failed');
      return `<html><body>Log Viewer UI missing.</body></html>`;
    }
  }
}
