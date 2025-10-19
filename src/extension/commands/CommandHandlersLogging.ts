// === src/extension/commands/CommandHandlersLogging.ts ===
import { measure } from '../../core/logging/perf.js';
import type { EdgePanelProvider } from '../panels/extensionPanel.js';

export class CommandHandlersLogging {
  constructor(
    private say: (s: string) => void,
    private appendLog?: (s: string) => void,
    private provider?: EdgePanelProvider, // 🔁 Provider 주입
  ) {}

  /** 버튼/명령 진입점(공식 경로) */
  @measure()
  async openHomeyLogging() {
    this.appendLog?.('[debug] logging: command invoked → openHomeyLogging()');
    if (!this.provider) {
      this.appendLog?.('[error] logging: provider not ready');
      return this.say('[error] internal: provider not ready');
    }
    try {
      await this.provider.handleHomeyLoggingCommand();
      this.appendLog?.('[info] logging: Homey Log Viewer panel opened');
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      this.appendLog?.(`[error] logging: failed to open viewer: ${msg}`);
      throw e;
    }
  }

  // --- 과거 stub은 주석만 남김 ---
  // loggingStart / loggingMerge / loggingStop 은 사용하지 않습니다.
  // 실사용 경로는 openHomeyLogging() → Provider → LogViewerPanelManager 입니다.
}
