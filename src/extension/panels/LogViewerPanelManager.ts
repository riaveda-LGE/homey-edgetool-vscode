// src/extension/panels/LogViewerPanelManager.ts
// === src/extension/panels/LogViewerPanelManager.ts ===
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  getCurrentWorkspacePathFs,
  readLogViewerPrefs,
  writeLogViewerPrefs,
} from '../../core/config/userdata.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { LogSessionManager } from '../../core/sessions/LogSessionManager.js';
import { MERGED_DIR_NAME, RAW_DIR_NAME } from '../../shared/const.js';
import { HostWebviewBridge } from '../messaging/hostWebviewBridge.js';
import { paginationService } from '../../core/logs/PaginationService.js';

export class LogViewerPanelManager {
  private log = getLogger('LogViewerPanelManager');
  private panel?: vscode.WebviewPanel;
  private bridge?: HostWebviewBridge;
  private session?: LogSessionManager;

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
    this.log.debug('[debug] LogViewerPanelManager dispose: start');
    try {
      this.session?.dispose();
    } catch {}
    this.session = undefined;
    if (this.panel) this.panel.dispose();
    this.log.debug('[debug] LogViewerPanelManager dispose: end');
  }

  async handleHomeyLoggingCommand() {
    const already = !!this.panel;
    this.log.debug(`[debug] LogViewerPanelManager.handleHomeyLoggingCommand: start panelExists=${already}`);
    this.log.debug(`[debug] viewer: handleHomeyLoggingCommand (panelExists=${already})`);

    // ✅ 버튼 누른 순간 raw 초기화 시도
    const wsRoot = await this._resolveWorkspaceRoot();
    if (wsRoot) {
      try {
        await this._cleanupRaw(wsRoot);
        this.log.info(`viewer: raw folder cleaned (${path.join(wsRoot, RAW_DIR_NAME)})`);
      } catch (e: any) {
        this.log.error(`viewer: raw cleanup failed ${String(e?.message ?? e)}`);
      }
    } else {
      this.log.warn('viewer: no workspace root; skip raw cleanup');
    }

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
        this.log.info('viewer: panel disposed');
        try {
          this.bridge?.dispose?.();
        } catch {}
        this.bridge = undefined;
        this.panel = undefined;
      });

      // 정식 Log Viewer UI 로드
      const uiRoot = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webviewers', 'log-viewer');
      this.log.debug('viewer: loading UI html…');
      this.panel.webview.html = await this._getHtmlFromFiles(this.panel.webview, uiRoot);
      this.log.info('viewer: UI html loaded');

      // 메시지 라우팅을 bridge로 일원화
      this.bridge = new HostWebviewBridge(this.panel, {
        onUiLog: ({ level, text, source, line }) => {},
        readUserPrefs: async () => {
          this.log.debug('viewer: getUserPrefs requested');
          const prefs = await readLogViewerPrefs(this.context);
          this.log.debug('viewer: getUserPrefs responded');
          return prefs;
        },
        writeUserPrefs: async (patch: any) => {
          await writeLogViewerPrefs(this.context, patch ?? {});
          this.log.debug('viewer: prefs saved');
        },
      });
      this.bridge.start();
      this.log.debug('viewer: host-webview bridge started');

      this.log.info('Homey Log Viewer opened');
      await vscode.commands.executeCommand('homey.logging.openViewer');
    }
    this.panel.reveal(undefined, true);
    this.log.debug(`LogViewerPanelManager.handleHomeyLoggingCommand: end`);
  }

  /** 실시간 세션 시작: 라인 들어오는 대로 즉시 UI 전송 */
  async startRealtime(filter?: string) {
    this.log.debug('[debug] LogViewerPanelManager startRealtime: start');
    if (!this.panel) await this.handleHomeyLoggingCommand();
    this.mode = 'realtime';
    this.initialSent = true; // 실시간은 제한 없음
    this.log.info(`realtime: start (filter=${filter ?? ''})`);

    this.session?.dispose();
    this.session = new LogSessionManager({ id: 'default', type: 'adb', timeoutMs: 15000 });

    await this.session.startRealtimeSession({
      filter,
      onBatch: (logs) => {
        if ((logs?.length ?? 0) > 0) {
          this.log.debug(`realtime: batch ${logs.length} lines`);
        }
        this._send('logs.batch', { logs });
      },
      onMetrics: (m) => {
        this._send('metrics.update', m);
      },
    });
    this.log.debug('[debug] LogViewerPanelManager startRealtime: end');
  }

  /** 파일 병합 세션 시작: 최초 최신 LOG_WINDOW_SIZE만 보내고, 이후는 스크롤 요청에 따른 페이지 읽기 */
  async startFileMerge(dir: string) {
    this.log.debug('[debug] LogViewerPanelManager startFileMerge: start');
    if (!this.panel) await this.handleHomeyLoggingCommand();
    this.mode = 'filemerge';
    this.initialSent = false;
    this.log.info(`merge: start (dir=${dir})`);

    // 🔒 샘플링 상태 리셋 (권장)
    this.progAcc = 0;
    this.progDoneAcc = 0;
    this.progTotal = undefined;
    this.progLastLogMs = 0;

    // ✅ 병합 결과 저장 위치를 workspace/raw/merge_log 로 고정
    const wsRoot = await this._resolveWorkspaceRoot();
    const indexOutDir = wsRoot ? path.join(wsRoot, RAW_DIR_NAME, MERGED_DIR_NAME) : undefined;
    if (!wsRoot) {
      this.log.warn('merge: no workspace folder, fallback to default outDir');
    }

    this.session?.dispose();
    this.session = new LogSessionManager(undefined);

    await this.session.startFileMergeSession({
      dir,
      indexOutDir,
      onBatch: (logs, total, seq) => {
        if (this.initialSent) return;
        this.log.info(
          `merge: initial batch delivered (len=${logs.length}, total=${total ?? -1}, seq=${seq ?? -1})`,
        );
        // 초기 배치에도 현재 pagination 버전을 함께 전달(웹뷰 버전 동기화)
        const ver = paginationService.getVersion();
        this._send('logs.batch', { logs, total, seq, version: ver });
        this.initialSent = true;
      },
      onSaved: (info) => {
        this.log.info(
          `merge: saved outDir=${info.outDir} chunks=${info.chunkCount} total=${info.total ?? -1} merged=${info.merged}`,
        );
        this._send('logmerge.saved', info);
      },
      onMetrics: (m) => this._send('metrics.update', m),

      // 정식 병합(T1) 완료 → UI 하드리프레시
      onRefresh: ({ total, version }) => {
        this.log.info(
          `merge: refresh requested (total=${total ?? '?'}, version=${version ?? '?'})`,
        );
        this._send('logs.refresh', {
          reason: 'full-reindex',
          total,
          version,
        });
      },

      // ── 진행률: 로그는 샘플링해서 출력, 메시지 전달은 매번 유지 ─────────
      onProgress: (p) => {
        const { inc, total, done, active } = p ?? {};
        // 항상 웹뷰에는 전달
        this._send('merge.progress', { inc, total, done, active });

        // ─ 로그 노이즈 억제 ─
        const now = Date.now();
        if (active) {
          if (typeof total === 'number') this.progTotal = total;
          const add = typeof inc === 'number' ? inc : 0;
          this.progAcc += add;
          this.progDoneAcc += add;

          // 조건: 누적 라인 임계 + 최소 간격 충족 시에만 1줄 로그
          if (
            this.progAcc >= this.PROG_LINES_THRESHOLD &&
            now - this.progLastLogMs >= this.PROG_LOG_INTERVAL_MS
          ) {
            const pct =
              this.progTotal && this.progTotal > 0
                ? Math.floor((this.progDoneAcc / this.progTotal) * 100)
                : undefined;
            this.log.debug(
              `[debug] host→ui: merge.progress ~${pct ?? '?'}% (≈${this.progDoneAcc}/${this.progTotal ?? '?'})`,
            );
            this.progAcc = 0;
            this.progLastLogMs = now;
          }
        } else {
          // 완료 시에는 정확 수치 1회만 출력
          if (typeof total === 'number') this.progTotal = total;
          if (typeof done === 'number') this.progDoneAcc = done;
          const pct =
            this.progTotal && this.progTotal > 0
              ? Math.floor((this.progDoneAcc / this.progTotal) * 100)
              : 100;
          this.log.debug(
            `[debug] host→ui: merge.progress done=${this.progDoneAcc}/${this.progTotal ?? '?'} (${pct}%)`,
          );
          // 상태 초기화
          this.progAcc = 0;
          this.progDoneAcc = 0;
          this.progTotal = undefined;
          this.progLastLogMs = 0;
        }
      },
    });
    this.log.debug('[debug] LogViewerPanelManager startFileMerge: end');
  }

  stop() {
    this.log.debug('[debug] LogViewerPanelManager stop: start');
    this.session?.stopAll();
    this.log.info('Logging stopped');
    this.log.debug('[debug] LogViewerPanelManager stop: end');
  }

  private _send<T extends string>(type: T, payload: any) {
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
        this.log.debug(`[debug] host→ui: logs.refresh (total=${payload?.total ?? ''}, v=${payload?.version ?? ''})`);
      }
      this.bridge?.send({ v: 1, type, payload } as any);
    } catch {}
  }

  // ─────────────────────────────────────────────────────────
  // Workspace helpers — userdata 우선 → 표준 VS Code → fallback
  // ─────────────────────────────────────────────────────────
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

  private async _cleanupRaw(wsRoot: string) {
    const rawDir = path.join(wsRoot, RAW_DIR_NAME);
    try {
      await fs.promises.rm(rawDir, { recursive: true, force: true });
    } catch {}
    await fs.promises.mkdir(rawDir, { recursive: true });
  }

  // ─────────────────────────────────────────────────────────
  // 정식 UI HTML 로드 (CSP/nonce 및 리소스 경로 재작성)
  // ─────────────────────────────────────────────────────────
  private _randomNonce(len = 32) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < len; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
  }

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
