// === src/extension/commands/CommandHandlersLogging.ts ===
import * as vscode from 'vscode';
import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';

const log = getLogger('cmd.logging');

export class CommandHandlersLogging {
  constructor(
    private say: (s: string) => void,
    private appendLog?: (s: string) => void,
  ) {}

  @measure()
  async loggingStart() {
    this.say('[info] start realtime logging (stub)');
  }

  @measure()
  async loggingMerge(dir: string) {
    if (!dir) return this.say('[error] directory path required');
    this.say(`[info] start file-merge logging for ${dir} (stub)`);
  }

  @measure()
  async loggingStop() {
    this.say('[info] logging stopped (stub)');
  }
}
