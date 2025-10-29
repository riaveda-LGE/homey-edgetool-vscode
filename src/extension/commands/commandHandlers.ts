// === src/extension/commands/commandHandlers.ts ===
import { exec as execCb } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

// 사용자 구성 저장소
import { resolveWorkspaceInfo } from '../../core/config/userdata.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';
import type { EdgePanelProvider } from '../panels/extensionPanel.js';
import { CommandHandlersConnect } from './CommandHandlersConnect.js';
import { CommandHandlersGit } from './CommandHandlersGit.js';
import { CommandHandlersHomey } from './CommandHandlersHomey.js';
import { CommandHandlersHost } from './CommandHandlersHost.js';
import { CommandHandlersLogging } from './CommandHandlersLogging.js';
import { CommandHandlersParser } from './CommandHandlersParser.js';
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
  private parserHandler: CommandHandlersParser;

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
    this.gitHandler = new CommandHandlersGit(this.context);
    this.connectHandler = new CommandHandlersConnect(this.context);
    this.parserHandler = new CommandHandlersParser(this.context);
  }

  @measure()
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
      case 'openHostShell':
        return this.hostHandler.openHostShell();

      case 'changeWorkspaceQuick':
        return this.workspaceHandler.changeWorkspaceQuick();
      case 'openWorkspace':
        return this.workspaceHandler.openWorkspace();
      case 'openWorkspaceShell':
        return this.workspaceHandler.openWorkspaceShell();
      case 'togglePerformanceMonitoring':
        return this.workspaceHandler.togglePerformanceMonitoring(this.extensionUri);
      case 'gitFlow':
        return this.gitHandler.gitFlow();
      case 'updateNow':
        return this.updateHandler.updateNow();
      case 'openHelp':
        return this.updateHandler.openHelp();

      case 'initParser':
        return this.parserHandler.initParser();
      // === 새로 추가: 웹뷰 버튼 진입점
      case 'connectDevice':
        return this.connectHandler.connectDevice();

      default:
        log.info(`[info] unknown command: ${raw}`);
    }
  }

  @measure()
  async help() {
    log.info(`Commands:
  openHomeyLogging
  homeyRestart | homeyMount | homeyUnmount
  changeWorkspaceQuick | openWorkspace
  gitFlow (pull / push)
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
