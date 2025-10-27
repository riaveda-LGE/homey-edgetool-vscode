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
  constructor() {}

  @measure()
  async homeyRestart() {
    log.debug('[debug] CommandHandlersHomey homeyRestart: start');
    try {
      const controller = new HomeyController(defaultHostConfig);
      await controller.restart();
      log.debug('[debug] CommandHandlersHomey homeyRestart: end');
    } catch (e) {
      log.error('homeyRestart failed', e as any);
    }
  }

  @measure()
  async homeyMount() {
    log.debug('[debug] CommandHandlersHomey homeyMount: start');
    try {
      const controller = new HomeyController(defaultHostConfig);
      await controller.mount();
      log.debug('[debug] CommandHandlersHomey homeyMount: end');
    } catch (e) {
      log.error('homeyMount failed', e as any);
    }
  }

  @measure()
  async homeyUnmount() {
    log.debug('[debug] CommandHandlersHomey homeyUnmount: start');
    try {
      const controller = new HomeyController(defaultHostConfig);
      await controller.unmount();
      log.debug('[debug] CommandHandlersHomey homeyUnmount: end');
    } catch (e) {
      log.error('homeyUnmount failed', e as any);
    }
  }

  @measure()
  async homeyDevToken() {
    log.debug('[debug] CommandHandlersHomey homeyDevToken: start');
    try {
      // DevToken은 아직 구현되지 않음 - stub
      log.debug('[debug] CommandHandlersHomey homeyDevToken: end');
    } catch (e) {
      log.error('homeyDevToken failed', e as any);
    }
  }

  @measure()
  async homeyConsoleToggle() {
    log.debug('[debug] CommandHandlersHomey homeyConsoleToggle: start');
    try {
      // Console toggle은 아직 구현되지 않음 - stub
      log.debug('[debug] CommandHandlersHomey homeyConsoleToggle: end');
    } catch (e) {
      log.error('homeyConsoleToggle failed', e as any);
    }
  }

  @measure()
  async homeyDockerUpdate() {
    log.debug('[debug] CommandHandlersHomey homeyDockerUpdate: start');
    try {
      // Docker update는 아직 구현되지 않음 - stub
      log.debug('[debug] CommandHandlersHomey homeyDockerUpdate: end');
    } catch (e) {
      log.error('homeyDockerUpdate failed', e as any);
    }
  }
}
