// === src/extension/main.ts ===
import * as vscode from 'vscode';

// 사용자 저장 구성 요소
import { resolveWorkspaceInfo } from '../core/config/userdata.js';
import { getLogger, patchConsole, setLogLevel } from '../core/logging/extension-logger.js';
import { globalProfiler } from '../core/logging/perf.js';
import { LOG_LEVEL_DEFAULT } from '../shared/const.js';
import { PerfMonitorPanel } from './editors/PerfMonitorPanel.js';
import { EdgePanelProvider, registerEdgePanelCommands } from './panels/extensionPanel.js';
import { checkLatestVersion } from './update/updater.js';

export async function activate(context: vscode.ExtensionContext) {
  return globalProfiler.measureFunction('activate', async () => {
    setLogLevel(LOG_LEVEL_DEFAULT);
    patchConsole();

    const log = getLogger('main');
    log.info('activate() start');

    // ─────────────────────────────────────────────────────────
    // [Global Error → UI 로그] Extension Host 전역 에러 스니퍼
    // 우리 확장 경로에서 기원한 에러만 잡아 UI 로그로 보낸다.
    // ─────────────────────────────────────────────────────────
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

    const toPretty = (e: unknown) => {
      try {
        if (e instanceof Error) return `${e.name}: ${e.message}\n${e.stack ?? ''}`;
        if (typeof e === 'string') return e;
        return JSON.stringify(e);
      } catch {
        return String(e);
      }
    };

    const onUncaught = (e: unknown) => {
      if (!isFromThisExtension(e)) return;
      const g = getLogger('global');
      g.error('uncaughtException', e as any);
      const msg = (e as Error)?.message ?? String(e);
      vscode.window.showErrorMessage(`uncaughtException: ${msg}`);
    };

    const onUnhandled = (reason: unknown) => {
      if (!isFromThisExtension(reason)) return;
      const g = getLogger('global');
      g.error('unhandledRejection', reason as any);
      const msg = toPretty(reason);
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

      // ✅ Performance Monitor 인스턴스 생성
      const perfMonitor = PerfMonitorPanel.register(context, context.extensionUri);

      // ✅ constructor 시그니처: (extensionUri, context, version, latestInfo)
      const provider = new EdgePanelProvider(
        context.extensionUri,
        context,
        version,
        latestInfo,
        perfMonitor,
      );
      try {
        const disp = vscode.window.registerWebviewViewProvider(
          EdgePanelProvider.viewType,
          provider,
        );
        context.subscriptions.push(disp);
      } catch (e) {
        log.info('registerWebviewViewProvider already registered, skipping', e as any);
      }

      // ✅ homey-logging을 외부 커맨드로 노출
      registerEdgePanelCommands(context, provider);

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
