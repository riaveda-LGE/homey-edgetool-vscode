// === src/extension/commands/CommandHandlersGit.ts ===
import * as vscode from 'vscode';

import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';

const log = getLogger('cmd.git');

export class CommandHandlersGit {
  constructor(
  ) {}

  @measure()
  async gitPassthrough(args: string[]) {
    log.debug('[debug] CommandHandlersGit gitPassthrough: start');
    log.debug('[debug] CommandHandlersGit gitPassthrough: end');
  }
}
