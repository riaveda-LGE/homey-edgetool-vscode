// === src/extension/commands/CommandHandlersHomey.ts ===
import * as vscode from 'vscode';

import { HomeyController } from '../../core/controller/HomeyController.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';
import { getEnvToggleEnabled, getMountState } from '../../core/state/DeviceState.js';

const log = getLogger('cmd.homey');

export class CommandHandlersHomey {
  constructor() {}

  @measure()
  async homeyRestart() {
    log.debug('[debug] CommandHandlersHomey homeyRestart: start');
    try {
      const controller = new HomeyController();
      await controller.restart();
      log.debug('[debug] CommandHandlersHomey homeyRestart: end');
    } catch (e) {
      log.error('homeyRestart failed', e as any);
    }
  }

  // ── 새 토글 핸들러들 ──────────────────────────────────────────────
  @measure()
  async homeyVolumeToggle() {
    log.debug('[debug] CommandHandlersHomey homeyVolumeToggle: start');
    try {
      const state = await getMountState();
      const controller = new HomeyController();
      if (state === 'mounted') {
        await controller.unmount();
      } else {
        await controller.mount();
      }
      log.debug('[debug] CommandHandlersHomey homeyVolumeToggle: end');
    } catch (e) {
      log.error('homeyVolumeToggle failed', e as any);
    }
  }

  @measure()
  async homeyAppLogToggle() {
    log.debug('[debug] CommandHandlersHomey homeyAppLogToggle: start');
    try {
      const enabled = await getEnvToggleEnabled('HOMEY_APP_LOG');
      const controller = new HomeyController();
      await controller.toggleAppLog(!enabled);
      log.debug('[debug] CommandHandlersHomey homeyAppLogToggle: end');
    } catch (e) {
      log.error('homeyAppLogToggle failed', e as any);
    }
  }

  @measure()
  async homeyDevTokenToggle() {
    log.debug('[debug] CommandHandlersHomey homeyDevTokenToggle: start');
    try {
      const enabled = await getEnvToggleEnabled('HOMEY_DEV_TOKEN');
      const controller = new HomeyController();
      await controller.toggleDevToken(!enabled);
      log.debug('[debug] CommandHandlersHomey homeyDevTokenToggle: end');
    } catch (e) {
      log.error('homeyDevTokenToggle failed', e as any);
    }
  }

  @measure()
  async homeyDockerUpdate() {
    log.debug('[debug] CommandHandlersHomey homeyDockerUpdate: start');
    try {
      log.debug('[debug] CommandHandlersHomey homeyDockerUpdate: end');
    } catch (e) {
      log.error('homeyDockerUpdate failed', e as any);
    }
  }
}
