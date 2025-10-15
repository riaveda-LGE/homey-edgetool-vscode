// === src/extension/editors/PerfMonitorCommandHandler.ts ===
import * as vscode from 'vscode';
import type { IPerfMonitorDataManager, IPerfMonitorWebviewManager } from './IPerfMonitorComponents.js';

export class PerfMonitorCommandHandler {
  constructor(
    private _dataManager: IPerfMonitorDataManager,
    private _webviewManager: IPerfMonitorWebviewManager,
  ) {}

  registerCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    // 명령어 등록 - on/off 선택
    const openCommand = vscode.commands.registerCommand('homey.openPerfMonitor', async () => {
      const items = [
        { label: 'ON - 성능 모니터링 시작', description: '실시간 성능 데이터를 모니터링합니다', value: 'on' },
        { label: 'OFF - 성능 모니터링 종료', description: '모니터링을 중지하고 창을 닫습니다', value: 'off' }
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: '성능 모니터링 모드를 선택하세요',
        matchOnDescription: true
      });

      if (!selected) return;

      if (selected.value === 'on') {
        // ON 선택: 모니터링 시작
        this._dataManager.setPerfMode(true);
        this._webviewManager.createPanel();
      } else {
        // OFF 선택: 모니터링 중지 및 창 닫기
        this._dataManager.setPerfMode(false);
        this._webviewManager.closePanel();
      }
    });

    disposables.push(openCommand);

    return disposables;
  }
}
