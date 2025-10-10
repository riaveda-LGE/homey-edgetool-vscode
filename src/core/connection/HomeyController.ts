// === src/core/connection/HomeyController.ts ===
import { getLogger } from '../logging/extension-logger.js';
import type { HostConfig } from './ConnectionManager.js';

const log = getLogger('HomeyController');

export class HomeyController {
  constructor(private cfg: HostConfig) {}

  async mount() {
    log.info('[stub] homey-mount');
  }
  async unmount() {
    log.info('[stub] homey-unmount');
  }
  async restart() {
    log.info('[stub] homey-restart');
  }
  async gitPull(path?: string) {
    log.info('[stub] git pull', path || '');
  }
  async gitPush(path?: string) {
    log.info('[stub] git push', path || '');
  }
}
