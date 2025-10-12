// === src/extension/commands/registerCommands.ts ===
import * as vscode from 'vscode';
import { getLogger } from '../../core/logging/extension-logger.js';
import { COMMAND_UPDATE_NOW } from '../../shared/const.js';
import { createCommandHandlers } from './commandHandlers.js';

const log = getLogger('commands');

export function registerCommands(context: vscode.ExtensionContext) {
  const handlers = createCommandHandlers(undefined, context);

  const d1 = vscode.commands.registerCommand(COMMAND_UPDATE_NOW, async () => {
    await handlers.updateNow();
  });

  const d2 = vscode.commands.registerCommand('homeyEdgetool.changeWorkspace', async () => {
    await handlers.changeWorkspace('');
  });

  context.subscriptions.push(d1, d2);
}

// EdgePanel에서 콘솔 라인 실행
export async function runConsoleCommand(
  line: string,
  appendLog?: (s: string) => void,
  context?: vscode.ExtensionContext,
) {
  const handlers = createCommandHandlers(appendLog, context);
  await handlers.route(line);
}
