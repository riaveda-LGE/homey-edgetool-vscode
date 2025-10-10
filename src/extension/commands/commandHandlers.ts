// === src/extension/commands/commandHandlers.ts ===
import * as vscode from 'vscode';
import { getLogger } from '../../core/logging/extension-logger.js';
import { checkLatestVersion, downloadAndInstall } from '../update/updater.js';
import { READY_MARKER } from '../../shared/const.js';

const log = getLogger('cmd');

export function createCommandHandlers(appendLog?: (s: string) => void) {
  const say = (s: string) => {
    log.info(s);
    appendLog?.(s);
  };

  return {
    async route(raw: string) {
      const [cmd, ...rest] = String(raw || '').trim().split(/\s+/);
      switch (cmd) {
        case 'help':
        case 'h':
          return this.help();
        case 'homey-logging': {
          if (rest[0] === '--stop') return this.loggingStop();
          if (rest[0] === '--dir') return this.loggingMerge(rest.slice(1).join(' ').trim());
          return this.loggingStart();
        }
        case 'connect_info':
          return this.connectInfo();
        case 'connect_change':
          return this.connectChange();
        case 'host':
          return this.hostCommand(rest.join(' '));
        case 'git':
          return this.gitPassthrough(rest);
        default:
          say(`[info] unknown command: ${raw}`);
      }
    },

    async help() {
      say(`${READY_MARKER} Commands:
  help | h
  homey-logging
  homey-logging --stop
  homey-logging --dir <path>
  connect_info | connect_change
  host <cmd>
  git pull|push ...`);
    },

    async loggingStart() {
      say('[info] start realtime logging (stub)');
      // 실제 구현은 LogSessionManager 사용
    },

    async loggingMerge(dir: string) {
      if (!dir) return say('[error] directory path required');
      say(`[info] start file-merge logging for ${dir} (stub)`);
    },

    async loggingStop() {
      say('[info] logging stopped (stub)');
    },

    async connectInfo() {
      say('[info] connect_info (stub)');
    },

    async connectChange() {
      say('[info] connect_change (stub)');
    },

    async hostCommand(cmd: string) {
      if (!cmd) return say('[error] host <command>');
      say(`[info] host passthrough: ${cmd} (stub)`);
    },

    async gitPassthrough(args: string[]) {
      say(`[info] git ${args.join(' ')} (stub)`);
    },

    async updateNow() {
      try {
        const version = vscode.extensions.getExtension('lge.homey-edgetool')?.packageJSON?.version ?? '0.0.0';
        const latest = await checkLatestVersion(String(version));
        if (!latest.hasUpdate || !latest.url) {
          vscode.window.showInformationMessage('No update available.');
          return;
        }
        const out = (s: string) => appendLog?.(s);
        await downloadAndInstall(latest.url, out, latest.sha256);
      } catch (e) {
        log.error('updateNow failed', e as any);
        vscode.window.showErrorMessage('Update failed: ' + (e as Error).message);
      }
    },
  };
}
