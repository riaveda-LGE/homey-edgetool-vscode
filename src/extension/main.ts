// === src/extension/main.ts ===
import * as vscode from 'vscode';

import { checkLatestVersion } from './update/updater.js';
import { getLogger, patchConsole, setLogLevel } from '../core/logging/extension-logger.js';
import { EdgePanelProvider } from './panels/extensionPanel.js';
import { LOG_LEVEL_DEFAULT } from '../shared/const.js';

export async function activate(context: vscode.ExtensionContext) {
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
  context.subscriptions.push({ dispose: () => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
  }});

  try {
    const version = String((context.extension as any).packageJSON?.version ?? '0.0.0');
    const latestInfo = await checkLatestVersion(version);
    log.info(`latestInfo: ${JSON.stringify(latestInfo)}`);

    const provider = new EdgePanelProvider(context.extensionUri, version, latestInfo);
    const disp = vscode.window.registerWebviewViewProvider(EdgePanelProvider.viewType, provider);
    context.subscriptions.push(disp);

    log.info(`registerWebviewViewProvider OK, viewType=${EdgePanelProvider.viewType}, version=${version}`);
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
