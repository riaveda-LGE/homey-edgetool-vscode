// === src/extension/commands/CommandHandlersHost.ts ===
import * as vscode from 'vscode';

import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';

const log = getLogger('cmd.host');

export class CommandHandlersHost {
  constructor() {}

  @measure()
  async hostCommand(cmd: string) {
    log.debug('[debug] CommandHandlersHost hostCommand: start');
    if (!cmd) return log.error('[error] host <command>');
    log.info(`[info] host passthrough: ${cmd} (stub)`);
  }
}
