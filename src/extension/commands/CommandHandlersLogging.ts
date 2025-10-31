// === src/extension/commands/CommandHandlersLogging.ts ===
import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';
import type { EdgePanelProvider } from '../panels/extensionPanel.js';

const log = getLogger('cmd.logging');

export class CommandHandlersLogging {
  constructor(
    private provider?: EdgePanelProvider, // 🔁 Provider 주입
  ) {}

  /** 새 버튼: 실시간 로그 보기 (필터 입력 없이 바로 시작) */
  @measure()
  async startRealtime() {
    log.debug('CommandHandlersLogging.startRealtime: start');
    if (!this.provider) {
      log.error('logging: provider not ready');
      return;
    }
    try {
      await this.provider.startRealtime(undefined);
      log.info('logging: started realtime session');
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      log.error('logging: startRealtime failed', { error: msg });
      throw e;
    }
  }

  /** 새 버튼: 로그 파일 열기 (폴더 선택 다이얼로그 → 병합 시작) */
  @measure()
  async startFileMerge() {
    log.debug('CommandHandlersLogging.startFileMerge: start');
    if (!this.provider) {
      log.error('logging: provider not ready');
      return;
    }
    try {
      // 1) 웹 로그 뷰어를 먼저 오픈 (QuickPick 없이)
      await this.provider.handleHomeyLoggingCommand();

      // 2) 폴더 선택 다이얼로그 표시
      const picked = await (
        await import('vscode')
      ).window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: '병합할 로그 디렉터리를 선택하세요',
      });
      if (picked && picked[0]) {
        await this.provider.startFileMerge(picked[0].fsPath);
        log.info('logging: started file-merge session');
      } else {
        log.debug('logging: startFileMerge cancelled by user');
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      log.error('logging: startFileMerge failed', { error: msg });
      throw e;
    }
  }
}
