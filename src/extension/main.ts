// === src/extension/main.ts ===
import * as vscode from 'vscode';

// 사용자 저장 구성 요소
import { resolveWorkspaceInfo } from '../core/config/userdata.js';
import { getLogger, patchConsole, setLogLevel } from '../core/logging/extension-logger.js';
import { LOG_LEVEL_DEFAULT } from '../shared/const.js';
import { EdgePanelProvider, registerEdgePanelCommands } from './panels/extensionPanel.js';
import { checkLatestVersion } from './update/updater.js';
import { PerfMonitorPanel } from './editors/PerfMonitorPanel.js';
import { globalProfiler } from '../core/logging/perf.js';

export async function activate(context: vscode.ExtensionContext) {
  return globalProfiler.measureFunction('activate', async () => {
    setLogLevel(LOG_LEVEL_DEFAULT);
    patchConsole();

    const log = getLogger('main');
    log.info('activate() start');

    // --- our-error detector ---
    const extRoot = context.extensionUri.fsPath.replace(/\\/g, '/');
    const isFromThisExtension = (err: unknown): boolean => {
      try {
        const stack = (err as any)?.stack ?? String(err ?? '');
        if (typeof stack !== 'string') return false;
        const norm = stack.replace(/\\/g, '/');
        return norm.includes(extRoot);
      } catch {
        return false;
      }
    };

    const onUncaught = (e: unknown) => {
      if (!isFromThisExtension(e)) return;
      const g = getLogger('global');
      g.error('uncaughtException', e as any);
      const msg = (e as Error)?.message ?? String(e);
      vscode.window.showErrorMessage(`uncaughtException: ${msg}`);
    };
    const onUnhandled = (e: unknown) => {
      if (!isFromThisExtension(e)) return;
      const g = getLogger('global');
      g.error('unhandledRejection', e as any);
      const msg = (e as any)?.message ?? String(e);
      vscode.window.showErrorMessage(`unhandledRejection: ${msg}`);
    };

    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);
    context.subscriptions.push({
      dispose: () => {
        process.off('uncaughtException', onUncaught);
        process.off('unhandledRejection', onUnhandled);
      },
    });

    try {
      // 1) 워크스페이스 디렉토리 준비(없으면 생성 → UI 출력엔 영향 없음)
      await resolveWorkspaceInfo(context);

      // 2) 버전/업데이트 체크 및 패널 등록
      const version = String((context.extension as any).packageJSON?.version ?? '0.0.0');
      const latestInfo = await checkLatestVersion(version);
      log.info(`latestInfo: ${JSON.stringify(latestInfo)}`);

      // ✅ constructor 시그니처: (extensionUri, context, version, latestInfo)
      const provider = new EdgePanelProvider(context.extensionUri, context, version, latestInfo);
      const disp = vscode.window.registerWebviewViewProvider(EdgePanelProvider.viewType, provider);
      context.subscriptions.push(disp);

      // ✅ homey-logging을 외부 커맨드로 노출
      registerEdgePanelCommands(context, provider);

      // ✅ Performance Monitor 등록
      const perfProvider = new PerfMonitorPanel(context.extensionUri, context);

      // ✅ Performance Toggle 명령어 등록
      let isMonitoring = false;
      const toggleCommand = vscode.commands.registerCommand('performance.toggle', async () => {
        await globalProfiler.measureFunction('performance.toggle', async () => {
          const items = ['ON', 'OFF'];
          const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select Performance Monitoring',
          });
          if (selected === 'ON') {
            if (!isMonitoring) {
              perfProvider.createPanel();
              perfProvider.startMonitoring();
              vscode.window.showInformationMessage('Performance monitoring started.');
              isMonitoring = true;
            } else {
              vscode.window.showInformationMessage('Performance monitoring is already running.');
            }
          } else if (selected === 'OFF') {
            if (isMonitoring) {
              perfProvider.stopMonitoring();
              perfProvider.closePanel();
              vscode.window.showInformationMessage('Performance monitoring stopped.');
              isMonitoring = false;
            } else {
              vscode.window.showInformationMessage('Performance monitoring is not running.');
            }
          }
        });
      });
      context.subscriptions.push(toggleCommand);

      log.info(
        `registerWebviewViewProvider OK, viewType=${EdgePanelProvider.viewType}, version=${version}`,
      );
    } catch (e) {
      const log2 = getLogger('main');
      log2.error('registerWebviewViewProvider failed', e as any);
      vscode.window.showErrorMessage('EdgePanel register failed: ' + (e as Error).message);
    }

    log.info('activate() end');
  });
}

export function deactivate() {
  const log = getLogger('main');
  log.info('deactivate()');
}
