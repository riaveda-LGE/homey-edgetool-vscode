// === src/extension/commands/CommandHandlersHost.ts ===
import * as vscode from 'vscode';

import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';

const log = getLogger('cmd.host');

export class CommandHandlersHost {
  constructor(
    private say: (s: string) => void,
    private appendLog?: (s: string) => void,
  ) {}

  @measure()
  async hostCommand(cmd: string) {
    if (!cmd) return this.say('[error] host <command>');
    this.say(`[info] host passthrough: ${cmd} (stub)`);
  }
}
