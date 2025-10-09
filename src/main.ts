import * as vscode from 'vscode';

import { checkLatestVersion } from './update/updater.js';
import { getLogger, patchConsole, setLogLevel } from './util/extension-logger.js';
import { EdgePanelProvider } from './vscode-ui/extensionPanel.js';
import { LOG_LEVEL_DEFAULT } from './config/const.js';

export async function activate(context: vscode.ExtensionContext) {
  setLogLevel(LOG_LEVEL_DEFAULT);
  patchConsole();

  const log = getLogger('main');
  log.info('activate() start');

  // --- our-error detector: 스택에 우리 확장 경로가 포함될 때만 true ---
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

  // --- 전역 예외 리스너 (우리 코드에서 터진 것만 로깅/알림) ---
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
    const version = String((context.extension as any).packageJSON?.version ?? '0.0.0');
    const latestInfo = await checkLatestVersion(version);
    log.info(`latestInfo: ${JSON.stringify(latestInfo)}`);

    const provider = new EdgePanelProvider(context.extensionUri, version, latestInfo);
    const disp = vscode.window.registerWebviewViewProvider(EdgePanelProvider.viewType, provider);
    context.subscriptions.push(disp);

    log.info(
      `registerWebviewViewProvider OK, viewType=${EdgePanelProvider.viewType}, version=${version}`,
    );
  } catch (e) {
    log.error('registerWebviewViewProvider failed', e as any);
    vscode.window.showErrorMessage('EdgePanel register failed: ' + (e as Error).message);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('homeyEdgetool.hello', () => {
      log.debug('hello clicked');
      vscode.window.showInformationMessage('Homey EdgeTool activated (hello)');
    }),
  );

  log.info('activate() end');
}

export function deactivate() {
  const log = getLogger('main');
  log.info('deactivate()');
}
