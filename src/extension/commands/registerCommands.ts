// === src/extension/commands/registerCommands.ts ===
import * as vscode from 'vscode';
import { getLogger } from '../../core/logging/extension-logger.js';
import { COMMAND_HELLO, COMMAND_UPDATE_NOW } from '../../shared/const.js';
import { createCommandHandlers } from './commandHandlers.js';

const log = getLogger('commands');

export function registerCommands(context: vscode.ExtensionContext) {
  const handlers = createCommandHandlers();

  const d1 = vscode.commands.registerCommand(COMMAND_HELLO, async () => {
    log.debug('hello');
    vscode.window.showInformationMessage('Homey EdgeTool: Hello');
  });

  const d2 = vscode.commands.registerCommand(COMMAND_UPDATE_NOW, async () => {
    await handlers.updateNow();
  });

  context.subscriptions.push(d1, d2);
}

// (선택) EdgePanel에서 edge> 입력을 여기에 위임하고 싶다면 이 헬퍼 사용
export async function runConsoleCommand(line: string, appendLog?: (s: string) => void) {
  const handlers = createCommandHandlers(appendLog);
  await handlers.route(line);
}
