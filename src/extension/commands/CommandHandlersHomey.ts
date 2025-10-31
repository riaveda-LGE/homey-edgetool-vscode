// === src/extension/commands/CommandHandlersHomey.ts ===
import * as vscode from 'vscode';

import { HomeyController } from '../../core/controller/HomeyController.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';
import { discoverHomeyServiceName } from '../../core/service/serviceDiscovery.js';
import { resolveWorkspaceInfo } from '../../core/config/userdata.js';
import { USERCFG_REL } from '../../shared/const.js';

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

  @measure()
  async homeyMount() {
    // ✅ 정책 변경: QuickPick 없이 바로 두 볼륨(pro/core) 삽입
    log.debug('[debug] CommandHandlersHomey homeyMount: start');
    try {
      const controller = new HomeyController();
      await controller.mount(); // default: homey-app + homey-node
      log.debug('[debug] CommandHandlersHomey homeyMount: end');
    } catch (e) {
      log.error('homeyMount failed', e as any);
    }
  }

  @measure()
  async homeyUnmount() {
    log.debug('[debug] CommandHandlersHomey homeyUnmount: start');
    try {
      const controller = new HomeyController();
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
      const pick = await vscode.window.showQuickPick(['Enable', 'Disable'], {
        title: 'DevToken',
        ignoreFocusOut: true,
      });
      if (!pick) return;
      const enable = pick === 'Enable';
      const controller = new HomeyController();
      await controller.toggleDevToken(enable);
      log.debug('[debug] CommandHandlersHomey homeyDevToken: end');
    } catch (e) {
      log.error('homeyDevToken failed', e as any);
    }
  }

  @measure()
  async homeyConsoleToggle() {
    log.debug('[debug] CommandHandlersHomey homeyConsoleToggle: start');
    try {
      const pick = await vscode.window.showQuickPick(['Enable', 'Disable'], {
        title: 'App Log',
        ignoreFocusOut: true,
      });
      if (!pick) return;
      const enable = pick === 'Enable';
      const controller = new HomeyController();
      await controller.toggleAppLog(enable);
      log.debug('[debug] CommandHandlersHomey homeyConsoleToggle: end');
    } catch (e) {
      log.error('homeyConsoleToggle failed', e as any);
    }
  }

  @measure()
  async homeyDetectServiceNow() {
    try {
      const svc = await discoverHomeyServiceName((vscode as any).extensions?.extensionContext ?? ({} as vscode.ExtensionContext));
      if (svc) vscode.window.showInformationMessage(`Homey 서비스: ${svc}`);
    } catch (e) {
      log.error('homeyDetectServiceNow failed', e as any);
    }
  }

  @measure()
  async homeyEditServiceConfig() {
    try {
      const ctx = (vscode as any).extensions?.extensionContext as vscode.ExtensionContext | undefined;
      if (!ctx) { vscode.window.showErrorMessage('Extension context가 필요합니다.'); return; }
      const info = await resolveWorkspaceInfo(ctx);
      const uri = vscode.Uri.joinPath(info.wsDirUri, ...USERCFG_REL.split('/'));
      await vscode.window.showTextDocument(uri, { preview: false });
    } catch (e) {
      log.error('homeyEditServiceConfig failed', e as any);
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