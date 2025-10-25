// === src/extension/commands/CommandHandlersLogging.ts ===
import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';
import type { EdgePanelProvider } from '../panels/extensionPanel.js';

const log = getLogger('cmd.logging');

export class CommandHandlersLogging {
  constructor(
    private provider?: EdgePanelProvider, // 🔁 Provider 주입
  ) {}

  /** 버튼/명령 진입점(공식 경로) */
  @measure()
  async openHomeyLogging() {
    log.debug('CommandHandlersLogging.openHomeyLogging: start');
    if (!this.provider) {
      log.error('logging: provider not ready');
      return;
    }
    try {
      await this.provider.handleHomeyLoggingCommand();
      log.info('logging: Homey Log Viewer panel opened');
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      log.error('logging: failed to open viewer', { error: msg });
      throw e;
    }
  }

  // --- 과거 stub은 주석만 남김 ---
  // loggingStart / loggingMerge / loggingStop 은 사용하지 않습니다.
  // 실사용 경로는 openHomeyLogging() → Provider → LogViewerPanelManager 입니다.
}
