// === src/extension/commands/commandHandlers.ts ===
import { exec as execCb } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

// 사용자 구성 저장소
import { resolveWorkspaceInfo } from '../../core/config/userdata.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import type { EdgePanelProvider } from '../panels/extensionPanel.js';
import { CommandHandlersConnect } from './CommandHandlersConnect.js';
import { CommandHandlersGit } from './CommandHandlersGit.js';
import { CommandHandlersHomey } from './CommandHandlersHomey.js';
import { CommandHandlersHost } from './CommandHandlersHost.js';
import { CommandHandlersLogging } from './CommandHandlersLogging.js';
import { CommandHandlersUpdate } from './CommandHandlersUpdate.js';
import { CommandHandlersWorkspace } from './CommandHandlersWorkspace.js';

const log = getLogger('cmd');
const exec = promisify(execCb);

class CommandHandlers {
  // 분리된 핸들러들
  private workspaceHandler: CommandHandlersWorkspace;
  private updateHandler: CommandHandlersUpdate;
  private homeyHandler: CommandHandlersHomey;
  private loggingHandler: CommandHandlersLogging;
  private hostHandler: CommandHandlersHost;
  private gitHandler: CommandHandlersGit;
  private connectHandler: CommandHandlersConnect;

  constructor(
    private context?: vscode.ExtensionContext,
    private extensionUri?: vscode.Uri,
    private provider?: EdgePanelProvider, // 🔁 provider 주입 (Logging에서 사용)
  ) {
    // 핸들러 초기화
    this.workspaceHandler = new CommandHandlersWorkspace(this.context);
    this.updateHandler = new CommandHandlersUpdate(this.extensionUri);
    this.homeyHandler = new CommandHandlersHomey();
    this.loggingHandler = new CommandHandlersLogging(this.provider);
    this.hostHandler = new CommandHandlersHost();
    this.gitHandler = new CommandHandlersGit();
    this.connectHandler = new CommandHandlersConnect();
  }

  async route(raw: string) {
    const cmd = String(raw || '').trim();

    switch (cmd) {
      // === 기존 단축 명령(유지하되 최소 노출) ===
      case 'help':
      case 'h':
        return this.help();

      // === 버튼 → handler 진입점들 ===
      case 'openHomeyLogging':
        return this.loggingHandler.openHomeyLogging();

      case 'homeyRestart':
        return this.homeyHandler.homeyRestart();
      case 'homeyMount':
        return this.homeyHandler.homeyMount();
      case 'homeyUnmount':
        return this.homeyHandler.homeyUnmount();

      case 'changeWorkspaceQuick':
        return this.workspaceHandler.changeWorkspaceQuick();
      case 'openWorkspace':
        return this.workspaceHandler.openWorkspace();
      case 'togglePerformanceMonitoring':
        return this.workspaceHandler.togglePerformanceMonitoring(this.extensionUri);

      case 'gitPull':
        return this.gitHandler.gitPassthrough(['pull']);
      case 'gitPush':
        return this.gitHandler.gitPassthrough(['push']);

      case 'updateNow':
        return this.updateHandler.updateNow();
      case 'openHelp':
        return this.updateHandler.openHelp();

      // === 과거 라인 기반 명령들(가능한 쓰지 않음) ===
      case 'connect_info':
        return this.connectHandler.connectInfo();
      case 'connect_change':
        return this.connectHandler.connectChange();

      default:
        log.info(`[info] unknown command: ${raw}`);
    }
  }

  async help() {
    log.info(`Commands:
  openHomeyLogging
  homeyRestart | homeyMount | homeyUnmount
  changeWorkspaceQuick | openWorkspace
  gitPull | gitPush
  updateNow | openHelp`);
  }
}

export function createCommandHandlers(
  context?: vscode.ExtensionContext,
  extensionUri?: vscode.Uri,
  provider?: EdgePanelProvider,
) {
  return new CommandHandlers(context, extensionUri, provider);
}
