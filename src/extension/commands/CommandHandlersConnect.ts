// === src/extension/commands/CommandHandlersConnect.ts ===
import * as vscode from 'vscode';

import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';

const log = getLogger('cmd.connect');

export class CommandHandlersConnect {
  constructor() {}

  @measure()
  async connectInfo() {
    log.debug('[info] connect_info (stub)');
  }

  @measure()
  async connectChange() {
    log.debug('[debug] CommandHandlersConnect connectChange: start');
    log.debug('[debug] CommandHandlersConnect connectChange: end');
  }
}
