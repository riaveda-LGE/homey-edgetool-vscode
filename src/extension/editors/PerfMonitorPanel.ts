// === src/extension/editors/PerfMonitorPanel.ts ===
import * as vscode from 'vscode';

import { getLogger } from '../../core/logging/extension-logger.js';
import { globalProfiler, measure } from '../../core/logging/perf.js';
import { PERF_UPDATE_INTERVAL_MS } from '../../shared/const.js';
import type { H2W, W2H } from '@ipc/messages';
import type { PerfData } from './IPerfMonitorPanelComponents.js';
import { PerfMonitorCaptureManager } from './PerfMonitorCaptureManager.js';
import { PerfMonitorExportManager } from './PerfMonitorExportManager.js';
import { PerfMonitorHtmlGenerator } from './PerfMonitorHtmlGenerator.js';
import { PerfMonitorMessageHandler } from './PerfMonitorMessageHandler.js';

export class PerfMonitorPanel {
  public static readonly viewType = 'perfMonitor';
  private _panel?: vscode.WebviewPanel;
  private _interval?: NodeJS.Timeout;
  private _data: PerfData[] = [];
  private _isMonitoring = false;
  private _disposables = new Set<() => void>();

  // 분리된 컴포넌트들
  private _captureManager?: PerfMonitorCaptureManager;
  private _exportManager: PerfMonitorExportManager;
  private _htmlGenerator: PerfMonitorHtmlGenerator;
  private _messageHandler?: PerfMonitorMessageHandler;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {
    this._exportManager = new PerfMonitorExportManager(_context, (filePath) => {
      // 파일 생성 후 Homey Edge Tool의 Explorer 패널 갱신
      if (this._panel) {
        const relPath = vscode.workspace.asRelativePath(filePath);
        this._panel.webview.postMessage({ v: 1, type: 'explorer.fs.changed', payload: { path: relPath } });
      }
    });
    this._htmlGenerator = new PerfMonitorHtmlGenerator(_extensionUri);
  }

  private _trackDisposable(disposable: vscode.Disposable) {
    this._disposables.add(() => disposable.dispose());
  }

  // 정적 메서드로 명령어 등록
  public static register(context: vscode.ExtensionContext, extensionUri: vscode.Uri) {
    const perfProvider = new PerfMonitorPanel(extensionUri, context);

    // ✅ Performance Toggle 명령어 등록 (package.json에 선언된 명령어 구현)
    const toggleCommand = vscode.commands.registerCommand('performance.toggle', async () => {
      await globalProfiler.measureFunction('performance.toggle', async () => {
        perfProvider.createPanel();
      });
    });
    context.subscriptions.push(toggleCommand);

    return perfProvider;
  }

  @measure()
  public createPanel() {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.One);
      return;
    }

    this._panel = vscode.window.createWebviewPanel(
      PerfMonitorPanel.viewType,
      'Performance Monitor',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this._extensionUri],
      }
    );

    // 컴포넌트 초기화
    this._captureManager = new PerfMonitorCaptureManager(this._panel);
    this._messageHandler = new PerfMonitorMessageHandler(this._captureManager, this._exportManager);

    this._panel.webview.html = this._htmlGenerator.getHtmlForWebview(this._panel.webview);

    this._trackDisposable(this._panel.webview.onDidReceiveMessage(
      (message: W2H) => {
        this._messageHandler!.handleMessage(message);
      },
      undefined,
      []
    ));

    this._trackDisposable(this._panel.onDidDispose(() => {
      this.dispose();
    }));
  }

  @measure()
  public closePanel() {
    if (this._panel) {
      this._panel.dispose();
      this._panel = undefined;
    }
  }

  @measure()
  public dispose() {
    if (this._captureManager) {
      this._captureManager.dispose();
    }
    if (this._panel) {
      this._panel.dispose();
      this._panel = undefined;
    }
    // 모든 추적된 리소스 정리
    for (const dispose of this._disposables) {
      dispose();
    }
    this._disposables.clear();
  }
}
