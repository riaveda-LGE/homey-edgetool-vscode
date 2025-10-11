// === src/extension/panels/extensionPanel.ts ===
import * as fs from 'fs';
import * as vscode from 'vscode';

import {
  addLogSink,
  getBufferedLogs,
  getLogger,
  removeLogSink,
} from '../../core/logging/extension-logger.js';
import { LogSessionManager } from '../../core/sessions/LogSessionManager.js';
import { PANEL_VIEW_TYPE, READY_MARKER } from '../../shared/const.js';
import type { LogEntry } from '../messaging/messageTypes.js';
import { downloadAndInstall } from '../update/updater.js';
import type { HostConfig } from '../../core/connection/ConnectionManager.js';
import { runConsoleCommand } from '../commands/registerCommands.js';

// 🔸 device list 저장/조회 유틸
import {
  readDeviceList,
  addDevice,
  updateDeviceById,
  type DeviceEntry,
} from '../../core/config/userdata.js';

interface EdgePanelState {
  version: string;
  updateAvailable: boolean;
  latestVersion?: string;
  updateUrl?: string;
  latestSha?: string;
  lastCheckTime?: string;
  logs?: string[];
}

export class EdgePanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = PANEL_VIEW_TYPE;
  private _view?: vscode.WebviewView;
  private _sink?: (line: string) => void;
  private log = getLogger('edgePanel');
  private _state: EdgePanelState;

  private _session?: LogSessionManager;
  private _currentAbort?: AbortController;

  // 커스텀 로그 뷰어 패널 핸들
  private _logPanel?: vscode.WebviewPanel;

  // 🔹 저장/불러오기에 필요한 VS Code context (device list 연동용)
  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
    version: string,
    latestInfo?: { hasUpdate?: boolean; latest?: string; url?: string; sha256?: string },
  ) {
    this._state = {
      version,
      updateAvailable: !!latestInfo?.hasUpdate,
      latestVersion: latestInfo?.latest,
      updateUrl: latestInfo?.url,
      latestSha: latestInfo?.sha256,
      lastCheckTime: new Date().toISOString(),
      logs: getBufferedLogs(),
    };
  }

  public appendLog(line: string) {
    this._view?.webview.postMessage({ type: 'appendLog', text: line });
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;

    // 🔧 빌드 산출물 경로로 교체
    const uiRoot = vscode.Uri.joinPath(this._extensionUri, 'dist', 'ui', 'edge-panel');

    webviewView.webview.options = {
      enableScripts: true,
      // 🔧 웹뷰가 읽을 수 있는 로컬 리소스 루트 지정
      localResourceRoots: [uiRoot],
      ...({ retainContextWhenHidden: true } as any),
    };

    webviewView.title = `Edge Console - v${this._state.version}`;

    try {
      webviewView.webview.html = this._getHtmlFromFiles(webviewView.webview, uiRoot);
    } catch (e: any) {
      const msg = `Failed to load panel HTML: ${e?.message || e}`;
      this.log.error(msg);
      vscode.window.showErrorMessage(msg);
      // 최소한의 에러 페이지
      webviewView.webview.html = `<html><body style="color:#ddd;background:#1e1e1e;font-family:ui-monospace,Consolas,monospace;padding:12px">
        <h3>Edge Console</h3>
        <pre>${msg}</pre>
      </body></html>`;
      return;
    }

    // webview → extension
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg?.command === 'run') {
          const text = String(msg.text ?? '').trim();
          this.log.info(`edge> ${text}`);
          // ✅ 모든 입력을 라우터로 전달
          await runConsoleCommand(text, (s) => this.appendLog(s), this._context);
          return;
        } else if (msg?.type === 'ui.log' && msg?.v === 1) {
          // ✅ EdgePanel Webview에서 올라오는 UI 로그 수신
          const lvl = String(msg.payload?.level ?? 'info') as 'debug'|'info'|'warn'|'error';
          const text = String(msg.payload?.text ?? '');
          const src = String(msg.payload?.source ?? 'ui.edgePanel');
          const lg = getLogger(src);
          (lg[lvl] ?? lg.info).call(lg, text);
          return;
        } else if (msg?.command === 'ready') {
          this._state.logs = getBufferedLogs();
          webviewView.webview.postMessage({ type: 'initState', state: this._state });
          webviewView.webview.postMessage({
            type: 'setUpdateVisible',
            visible: !!(this._state.updateAvailable && this._state.updateUrl),
          });
          this.appendLog(`${READY_MARKER} Ready. Type a command after "edge>" and hit Enter.`);
        } else if (msg?.command === 'versionUpdate') {
          if (!this._state.updateUrl) {
            this.appendLog('[update] 최신 버전 URL이 없습니다.');
            return;
          }
          this.appendLog('[update] 업데이트를 시작합니다...');
          await downloadAndInstall(
            this._state.updateUrl,
            (line) => this.appendLog(line),
            this._state.latestSha,
          );
        } else if (msg?.command === 'reloadWindow') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } catch (e) {
        this.log.error('onDidReceiveMessage error', e as any);
      }
    });

    // 가시성 변화마다 버퍼 재주입
    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) return;
      try {
        const state = { ...this._state, logs: getBufferedLogs() };
        webviewView.webview.postMessage({ type: 'initState', state });
      } catch {}
    });

    // OutputChannel → EdgePanel
    this._sink = (line: string) => {
      try {
        webviewView.webview.postMessage({ type: 'appendLog', text: line });
      } catch {}
    };
    addLogSink(this._sink);

    webviewView.onDidDispose(() => {
      if (this._sink) removeLogSink(this._sink);
      this._sink = undefined;

      this._session?.stopAll();
      this._currentAbort?.abort();
      this._session = undefined;
      this._currentAbort = undefined;

      this._view = undefined;
    });
  }

  // 🔹 public: 커맨드에서 호출할 수 있게
  public async handleHomeyLoggingCommand() {
    const pick = await vscode.window.showQuickPick(
      [
        { label: '실시간 로그 모드', value: 'realtime' },
        { label: '파일 병합 모드', value: 'filemerge' },
      ],
      { placeHolder: 'Homey Logging 모드를 선택하세요' },
    );
    if (!pick) return;

    const viewer = await this.openLogViewerPanel();

    if (pick.value === 'realtime') {
      this._session?.stopAll();
      this._currentAbort?.abort();

      const conn = await this.pickConnection();
      if (!conn) {
        viewer.webview.postMessage({
          v: 1,
          type: 'logs.batch',
          payload: {
            logs: [
              {
                id: Date.now(),
                ts: Date.now(),
                text: '실시간 로그가 취소되었습니다. (연결 정보가 제공되지 않음)',
              },
            ],
            seq: 1,
          },
        });
        return;
      }

      this._session = new LogSessionManager(conn);
      this._currentAbort = new AbortController();

      let seq = 0;
      await this._session.startRealtimeSession({
        signal: this._currentAbort.signal,
        onBatch: (logs: LogEntry[]) => {
          viewer.webview.postMessage({
            v: 1,
            type: 'logs.batch',
            payload: { logs, seq: ++seq },
          });
        },
        onMetrics: (m: { buffer: any; mem: { rss: number; heapUsed: number } }) => {
          viewer.webview.postMessage({
            v: 1,
            type: 'metrics.update',
            payload: m,
          });
        },
      });
      return;
    }

    if (pick.value === 'filemerge') {
      const dirPick = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: '로그 폴더 선택',
      });
      if (!dirPick || dirPick.length === 0) return;
      const dir = dirPick[0].fsPath;

      this._session?.stopAll();
      this._currentAbort?.abort();

      this._session = new LogSessionManager();
      this._currentAbort = new AbortController();

      let seq = 0;
      await this._session.startFileMergeSession({
        dir,
        signal: this._currentAbort.signal,
        onBatch: (logs: LogEntry[], total?: number) => {
          viewer.webview.postMessage({
            v: 1,
            type: 'logs.batch',
            payload: { logs, total, seq: ++seq },
          });
        },
        onMetrics: (m: { buffer: any; mem: { rss: number; heapUsed: number } }) => {
          viewer.webview.postMessage({
            v: 1,
            type: 'metrics.update',
            payload: m,
          });
        },
      });
    }
  }

  // 🔸 SSH/ADB 선택 + 최근 연결 + 새 연결 추가 → HostConfig
  private async pickConnection(): Promise<HostConfig | undefined> {
    const list = await readDeviceList(this._context);

    const deviceItems = list.map((d) => {
      const label =
        d.type === 'ssh'
          ? `SSH  ${d.host ?? ''}${d.port ? ':' + d.port : ''}${(d as any).user ? ` (${(d as any).user})` : ''}`
          : `ADB  ${(d as any).serial ?? d.id ?? ''}`;
      const desc = d.name || d.id || '';
      return {
        label,
        description: desc,
        detail: d.type === 'ssh' ? `${d.host ?? ''} ${(d as any).user ?? ''}` : `${(d as any).serial ?? ''}`,
        device: d,
        alwaysShow: true,
      } as vscode.QuickPickItem & { device: DeviceEntry };
    });

    const addItems: (vscode.QuickPickItem & { __action: 'add-ssh' | 'add-adb' })[] = [
      { label: '➕ 새 연결 추가 (SSH)', description: 'host/user/port 입력', __action: 'add-ssh' },
      { label: '➕ 새 연결 추가 (ADB)', description: 'serial 입력', __action: 'add-adb' },
    ];

    const pick = await vscode.window.showQuickPick(
      [...deviceItems, ...addItems],
      {
        placeHolder:
          deviceItems.length > 0
            ? '최근 연결을 선택하거나, 새 연결을 추가하세요'
            : '저장된 연결이 없습니다. 새 연결을 추가하세요',
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    if (!pick) return;

    if ((pick as any).device) {
      const d = (pick as any).device as DeviceEntry;
      return deviceEntryToHostConfig(d);
    }

    if ((pick as any).__action === 'add-ssh') {
      const host = await vscode.window.showInputBox({
        prompt: 'SSH Host (예: 192.168.0.10)',
        placeHolder: '호스트/IP',
        ignoreFocusOut: true,
        validateInput: (v) => (!v ? '필수 입력' : undefined),
      });
      if (!host) return;

      const user = await vscode.window.showInputBox({
        prompt: 'SSH User (예: root)',
        placeHolder: '사용자',
        ignoreFocusOut: true,
        validateInput: (v) => (!v ? '필수 입력' : undefined),
      });
      if (!user) return;

      const portStr = await vscode.window.showInputBox({
        prompt: 'SSH Port (엔터로 기본 22)',
        placeHolder: '22',
        ignoreFocusOut: true,
      });
      const port = portStr && /^\d+$/.test(portStr) ? parseInt(portStr, 10) : undefined;

      const friendly = await vscode.window.showInputBox({
        prompt: '표시 이름(선택)',
        placeHolder: '예: 거실-Homey SSH',
        ignoreFocusOut: true,
      });

      const id = `${host}:${port ?? 22}`;
      const entry: DeviceEntry = {
        id,
        type: 'ssh',
        name: friendly?.trim() || id,
        host,
        port,
        user,
      };

      const exist = list.find((x) => (x.id ?? '') === id);
      if (exist) {
        await updateDeviceById(this._context, id, entry);
      } else {
        await addDevice(this._context, entry);
      }

      return { id, type: 'ssh', host, port, user } as HostConfig;
    }

    if ((pick as any).__action === 'add-adb') {
      const serial = await vscode.window.showInputBox({
        prompt: 'ADB Serial (adb devices 에 보이는 시리얼)',
        placeHolder: 'device-serial',
        ignoreFocusOut: true,
        validateInput: (v) => (!v ? '필수 입력' : undefined),
      });
      if (!serial) return;

      const friendly = await vscode.window.showInputBox({
        prompt: '표시 이름(선택)',
        placeHolder: '예: 작업실-Homey ADB',
        ignoreFocusOut: true,
      });

      const id = serial;
      const entry: DeviceEntry = {
        id,
        type: 'adb',
        name: friendly?.trim() || id,
        serial,
      };

      const exist = list.find((x) => (x.id ?? '') === id);
      if (exist) {
        await updateDeviceById(this._context, id, entry);
      } else {
        await addDevice(this._context, entry);
      }

      return { id, type: 'adb', serial } as HostConfig;
    }

    return;
  }

  // 커스텀 로그 뷰어 열기/재사용
  private async openLogViewerPanel(): Promise<vscode.WebviewPanel> {
    if (this._logPanel) {
      try {
        this._logPanel.reveal(vscode.ViewColumn.Active);
        return this._logPanel;
      } catch {
        this._logPanel = undefined;
      }
    }

    const panel = vscode.window.createWebviewPanel(
      'homeyLogViewer',
      'Homey Log Viewer',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'ui', 'log-viewer')],
      },
    );

    const mediaRoot = vscode.Uri.joinPath(this._extensionUri, 'dist', 'ui', 'log-viewer');
    const htmlPath = vscode.Uri.joinPath(mediaRoot, 'index.html');
    let html = (await vscode.workspace.fs.readFile(htmlPath)).toString();
    html = html.replace(/%NONCE%/g, getNonce()).replace(/%CSP_SOURCE%/g, panel.webview.cspSource);
    panel.webview.html = html;

    // ✅ Log Viewer Webview에서도 ui.log 수신 처리
    panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.v === 1 && msg?.type === 'ui.log') {
        const lvl = String(msg.payload?.level ?? 'info') as 'debug'|'info'|'warn'|'error';
        const text = String(msg.payload?.text ?? '');
        const src = String(msg.payload?.source ?? 'ui.logViewer');
        const lg = getLogger(src);
        (lg[lvl] ?? lg.info).call(lg, text);
      }
    });

    panel.onDidDispose(() => {
      this._logPanel = undefined;
    });

    this._logPanel = panel;
    return panel;
  }

  private _getHtmlFromFiles(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const htmlPath = vscode.Uri.joinPath(mediaRoot, 'index.html');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.js'));

    const nonce = getNonce();
    const cspSource = webview.cspSource;

    let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
    html = html
      .replace(/%CSS_URI%/g, String(cssUri))
      .replace(/%JS_URI%/g, String(jsUri))
      .replace(/%NONCE%/g, nonce)
      .replace(/%CSP_SOURCE%/g, cspSource);

    return html;
  }
}

export function registerEdgePanelCommands(
  context: vscode.ExtensionContext,
  provider: EdgePanelProvider,
) {
  const d = vscode.commands.registerCommand('homeyEdgetool.openHomeyLogging', async () => {
    await provider.handleHomeyLoggingCommand();
  });
  context.subscriptions.push(d);
}

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

function deviceEntryToHostConfig(d: DeviceEntry): HostConfig {
  if (d.type === 'ssh') {
    const id = d.id ?? `${d.host ?? ''}:${d.port ?? 22}`;
    return {
      id,
      type: 'ssh',
      host: String(d.host ?? ''),
      port: typeof d.port === 'number' ? d.port : undefined,
      user: String((d as any).user ?? 'root'),
    };
  }
  return {
    id: d.id ?? String((d as any).serial ?? ''),
    type: 'adb',
    serial: String((d as any).serial ?? d.id ?? ''),
  };
}
