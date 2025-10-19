// === src/extension/commands/CommandHandlersHomey.ts ===
import * as vscode from 'vscode';

import type { HostConfig } from '../../core/connection/ConnectionManager.js';
import { HomeyController } from '../../core/connection/HomeyController.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';

const log = getLogger('cmd.homey');

// 기본 HostConfig (ADB)
const defaultHostConfig: HostConfig = {
  id: 'default',
  type: 'adb',
  serial: undefined,
  timeoutMs: 15000,
};

export class CommandHandlersHomey {
  constructor(
    private say: (s: string) => void,
    private appendLog?: (s: string) => void,
  ) {}

  @measure()
  async homeyRestart() {
    try {
      const controller = new HomeyController(defaultHostConfig);
      await controller.restart();
      this.say('[info] Homey restarted successfully.');
    } catch (e) {
      log.error('homeyRestart failed', e as any);
      this.say('[error] Homey restart failed: ' + (e as Error).message);
    }
  }

  @measure()
  async homeyMount() {
    try {
      const controller = new HomeyController(defaultHostConfig);
      await controller.mount();
      this.say('[info] Homey mounted successfully.');
    } catch (e) {
      log.error('homeyMount failed', e as any);
      this.say('[error] Homey mount failed: ' + (e as Error).message);
    }
  }

  @measure()
  async homeyUnmount() {
    try {
      const controller = new HomeyController(defaultHostConfig);
      await controller.unmount();
      this.say('[info] Homey unmounted successfully.');
    } catch (e) {
      log.error('homeyUnmount failed', e as any);
      this.say('[error] Homey unmount failed: ' + (e as Error).message);
    }
  }

  @measure()
  async homeyDevToken() {
    try {
      // DevToken은 아직 구현되지 않음 - stub
      this.say('[warn] homeyDevToken not implemented yet');
    } catch (e) {
      log.error('homeyDevToken failed', e as any);
      this.say('[error] Failed to get DevToken: ' + (e as Error).message);
    }
  }

  @measure()
  async homeyConsoleToggle() {
    try {
      // Console toggle은 아직 구현되지 않음 - stub
      this.say('[warn] homeyConsoleToggle not implemented yet');
    } catch (e) {
      log.error('homeyConsoleToggle failed', e as any);
      this.say('[error] Homey console toggle failed: ' + (e as Error).message);
    }
  }

  @measure()
  async homeyDockerUpdate() {
    try {
      // Docker update는 아직 구현되지 않음 - stub
      this.say('[warn] homeyDockerUpdate not implemented yet');
    } catch (e) {
      log.error('homeyDockerUpdate failed', e as any);
      this.say('[error] Homey Docker update failed: ' + (e as Error).message);
    }
  }
}
