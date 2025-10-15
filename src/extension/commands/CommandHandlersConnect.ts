// === src/extension/commands/CommandHandlersConnect.ts ===
import * as vscode from 'vscode';
import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';

const log = getLogger('cmd.connect');

export class CommandHandlersConnect {
  constructor(
    private say: (s: string) => void,
    private appendLog?: (s: string) => void,
  ) {}

  @measure()
  async connectInfo() {
    this.say('[info] connect_info (stub)');
  }

  @measure()
  async connectChange() {
    this.say('[info] connect_change (stub)');
  }
}
