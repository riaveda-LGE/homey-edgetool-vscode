// === src/extension/commands/CommandHandlersHost.ts ===
import * as vscode from 'vscode';

import { connectionManager } from '../../core/connection/ConnectionManager.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';
import { createSshTerminal } from '../terminals/SshTerminal.js';
import { createAdbTerminal } from '../terminals/AdbTerminal.js';

const log = getLogger('cmd.host');

export class CommandHandlersHost {
  constructor() {}

  @measure()
  async hostCommand(cmd: string) {
    log.debug('[debug] CommandHandlersHost hostCommand: start');
    if (!cmd) return log.error('[error] host <command>');
    log.info(`[info] host passthrough: ${cmd} (stub)`);
  }

  // 현재 활성 연결(ADB/SSH)로 셸을 연다.
  @measure()
  async openHostShell() {
    const snap = connectionManager.getSnapshot?.();
    const active = snap?.active;
    if (!active) {
      vscode.window.showErrorMessage('연결된 호스트가 없습니다. 먼저 연결하세요.');
      return;
    }

    // ADB: VS Code Pseudoterminal로 통일
    if (active.type === 'ADB') {
      const serial = (active.details as any)?.deviceID;
      const tty = createAdbTerminal(serial);
      const t = vscode.window.createTerminal({ name: tty.title, pty: tty.pty });
      t.show();
      log.info('openHostShell(adb): pty terminal opened', { title: tty.title });
      return;
    }

    // SSH: ssh2 + Pseudoterminal(비밀번호/키 입력 필요 없음)
    const tty = createSshTerminal();
    if (!tty) {
      vscode.window.showErrorMessage('SSH 연결 정보를 확인할 수 없습니다.');
      return;
    }
    const t = vscode.window.createTerminal({ name: tty.title, pty: tty.pty });
    t.show();
    log.info('openHostShell(ssh): pty terminal opened', { title: tty.title });
  }
}
