// === src/extension/commands/commandHandlers.ts ===
import * as vscode from 'vscode';
import * as path from 'path';
import { promisify } from 'util';
import { exec as execCb } from 'child_process';

// 사용자 구성 저장소
import { changeWorkspaceBaseDir, resolveWorkspaceInfo } from '../../core/config/userdata.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { checkLatestVersion, downloadAndInstall } from '../update/updater.js';
import { XError, ErrorCategory } from '../../shared/errors.js';
import { PerfMonitorPanel } from '../editors/PerfMonitorPanel.js';
import { measure } from '../../core/logging/perf.js';
import { CommandHandlersWorkspace } from './CommandHandlersWorkspace.js';
import { CommandHandlersUpdate } from './CommandHandlersUpdate.js';
import { CommandHandlersHomey } from './CommandHandlersHomey.js';
import { CommandHandlersLogging } from './CommandHandlersLogging.js';
import { CommandHandlersHost } from './CommandHandlersHost.js';
import { CommandHandlersGit } from './CommandHandlersGit.js';
import { CommandHandlersConnect } from './CommandHandlersConnect.js';

const log = getLogger('cmd');
const exec = promisify(execCb);

class CommandHandlers {
  private say: (s: string) => void;
  private workspaceInfoCache?: Awaited<ReturnType<typeof resolveWorkspaceInfo>>;
  private cacheExpiry = 0;
  private readonly CACHE_DURATION = 30000; // 30초 캐시

  // 분리된 핸들러들
  private workspaceHandler: CommandHandlersWorkspace;
  private updateHandler: CommandHandlersUpdate;
  private homeyHandler: CommandHandlersHomey;
  private loggingHandler: CommandHandlersLogging;
  private hostHandler: CommandHandlersHost;
  private gitHandler: CommandHandlersGit;
  private connectHandler: CommandHandlersConnect;

  constructor(
    private appendLog?: (s: string) => void,
    private context?: vscode.ExtensionContext,
    private extensionUri?: vscode.Uri,
  ) {
    this.say = (s: string) => {
      log.info(s);
      this.appendLog?.(s);
    };

    // 핸들러 초기화
    this.workspaceHandler = new CommandHandlersWorkspace(this.say, this.context);
    this.updateHandler = new CommandHandlersUpdate(this.say, this.appendLog, this.extensionUri);
    this.homeyHandler = new CommandHandlersHomey(this.say, this.appendLog);
    this.loggingHandler = new CommandHandlersLogging(this.say, this.appendLog);
    this.hostHandler = new CommandHandlersHost(this.say, this.appendLog);
    this.gitHandler = new CommandHandlersGit(this.say, this.appendLog);
    this.connectHandler = new CommandHandlersConnect(this.say, this.appendLog);
  }

  async route(raw: string) {
    const [cmd, ...rest] = String(raw || '')
      .trim()
      .split(/\s+/);
    switch (cmd) {
      case 'help':
      case 'h':
        return this.help();
      case 'homey-logging': {
        // ✅ EdgePanel의 공개 커맨드로 위임 (UI에서 모드 선택 + 세션 시작)
        await vscode.commands.executeCommand('homeyEdgetool.openHomeyLogging');
        return;
      }
      case 'connect_info':
        return this.connectHandler.connectInfo();
      case 'connect_change':
        return this.connectHandler.connectChange();
      case 'host':
        return this.hostHandler.hostCommand(rest.join(' '));
      case 'git':
        return this.gitHandler.gitPassthrough(rest);
      case 'change_workspace':
      case 'changeWorkspaceQuick':
        return this.workspaceHandler.changeWorkspaceQuick();
      case 'updateNow':
        return this.updateHandler.updateNow();
      case 'openHelp':
        return this.updateHandler.openHelp();
      case 'openWorkspace':
        return this.workspaceHandler.openWorkspace();
      case 'togglePerformanceMonitoring':
        return this.workspaceHandler.togglePerformanceMonitoring(this.extensionUri);
      default:
        this.say(`[info] unknown command: ${raw}`);
    }
  }

  async help() {
    this.say(`Commands:
  help | h
  homey-logging
  connect_info | connect_change
  host <cmd>
  git pull|push ...
  change_workspace`);
  }
}

export function createCommandHandlers(
  appendLog?: (s: string) => void,
  context?: vscode.ExtensionContext,
  extensionUri?: vscode.Uri,
) {
  return new CommandHandlers(appendLog, context, extensionUri);
}
