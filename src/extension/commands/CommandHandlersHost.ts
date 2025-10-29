// === src/extension/commands/CommandHandlersHost.ts ===
import * as vscode from 'vscode';
import { spawn } from 'child_process';

import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';
import { connectionManager } from '../../core/connection/ConnectionManager.js';

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

    let title = 'Host Shell';
    let command = '';
    if (active.type === 'ADB') {
      const serial = (active.details as any)?.deviceID;
      command = serial ? `adb -s ${serial} shell` : 'adb shell';
      title = `Host Shell (adb:${serial || 'default'})`;
    } else {
      const d = active.details as any;
      const p = d?.port && Number(d.port) !== 22 ? ` -p ${d.port}` : '';
      // 개발/테스트 편의: known_hosts를 완전히 우회해 호스트키 경고/충돌을 피한다.
      // (운영 전환 시 이 옵션 제거 권장)
      const sshOpts =
        ' -o StrictHostKeyChecking=no' +
        ' -o UserKnownHostsFile=NUL' +
        ' -o GlobalKnownHostsFile=NUL' +
        ' -o PreferredAuthentications=password' +
        ' -o PubkeyAuthentication=no';
      command = (d?.user && d?.host) ? `ssh${p}${sshOpts} ${d.user}@${d.host}` : `ssh${p}${sshOpts}`;
      title = `Host Shell (ssh:${d?.user || '?'}@${d?.host || '?'}${d?.port ? ':' + d.port : ''})`;
    }

// 외부 CMD 팝업으로 실행 (비추적)
      const escaped = command.replace(/'/g, "''");
      const ps = `Start-Process -FilePath 'cmd' -ArgumentList '/k','${escaped}' -WindowStyle Normal`;
      try {
        spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
        vscode.window.showInformationMessage(`장치 셸을 새 CMD 창으로 열었습니다: ${title}`);
        log.info('openHostShell(win):', { title, command });
      } catch (e: any) {
        log.error('openHostShell(win) failed', e);
        vscode.window.showErrorMessage(`셸 실행 실패: ${e?.message || e}`);
      }
  }
}
