// === src/core/connection/ConnectionManager.ts ===
import { getLogger } from '../logging/extension-logger.js';

export type HostConfig =
  | {
      id: string;
      type: 'ssh';
      host: string;
      port?: number;
      user: string;
      keyPath?: string;
      password?: string;
    }
  | { id: string; type: 'adb'; serial?: string };

export class ConnectionManager {
  private log = getLogger('ConnectionManager');
  constructor(private cfg: HostConfig) {}
  async connect() {
    this.log.info(`connect (stub) type=${this.cfg.type}`);
  }
  async run(cmd: string, args: string[] = []) {
    this.log.info(`run (stub): ${cmd} ${args.join(' ')}`);
    return { code: 0, stdout: 'stub-stdout', stderr: '' };
  }
  dispose() {
    this.log.info('dispose (stub)');
  }
}
