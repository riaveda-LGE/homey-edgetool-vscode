// === src/extension/commands/CommandHandlersGit.ts ===
import * as vscode from 'vscode';
import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';

const log = getLogger('cmd.git');

export class CommandHandlersGit {
  constructor(
    private say: (s: string) => void,
    private appendLog?: (s: string) => void,
  ) {}

  @measure()
  async gitPassthrough(args: string[]) {
    this.say(`[info] git ${args.join(' ')} (stub)`);
  }
}
