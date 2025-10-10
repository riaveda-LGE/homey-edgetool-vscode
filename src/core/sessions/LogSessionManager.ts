// === src/core/sessions/LogSessionManager.ts ===
import type { LogEntry } from '../../extension/messaging/messageTypes.js';
import { getLogger } from '../logging/extension-logger.js';
import { HybridLogBuffer } from '../logs/HybridLogBuffer.js';

export type SessionCallbacks = {
  onBatch: (logs: LogEntry[], total?: number, seq?: number) => void;
  onMetrics?: (m: { buffer: any; mem: { rss: number; heapUsed: number } }) => void;
};

export class LogSessionManager {
  private log = getLogger('LogSessionManager');
  private hb = new HybridLogBuffer();
  private seq = 0;

  /** 스텁: 실시간 스트림 시작 (지금은 가짜 로그 생성) */
  async startRealtimeSession(opts: { signal?: AbortSignal } & SessionCallbacks) {
    this.log.info('startRealtimeSession(stub)');

    const timer = setInterval(() => {
      const entry: LogEntry = {
        id: Date.now(),
        ts: Date.now(),
        level: 'I',
        type: 'system',
        source: 'stub-realtime',
        text: `stub realtime log ${new Date().toISOString()}`,
      };
      this.hb.add(entry);
      opts.onBatch([entry], undefined, ++this.seq);

      // 메트릭 예시
      opts.onMetrics?.({
        buffer: this.hb.getMetrics(),
        mem: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed },
      });
    }, 500);

    opts.signal?.addEventListener('abort', () => clearInterval(timer));
  }

  /** 스텁: 파일 병합 세션 (지금은 더미 배치 몇 번) */
  async startFileMergeSession(opts: { dir: string; signal?: AbortSignal } & SessionCallbacks) {
    this.log.info(`startFileMergeSession(stub) dir=${opts.dir}`);
    let cancelled = false;
    opts.signal?.addEventListener('abort', () => {
      cancelled = true;
    });

    for (let i = 0; i < 5; i++) {
      if (cancelled) break;
      const batch: LogEntry[] = Array.from({ length: 10 }).map((_, k) => ({
        id: Date.now() + k,
        ts: Date.now(),
        level: 'I',
        type: 'homey',
        source: `stub-file:${opts.dir}`,
        text: `merged log #${i}-${k}`,
      }));
      this.hb.addBatch(batch);
      opts.onBatch(batch, undefined, ++this.seq);
      await new Promise((r) => setTimeout(r, 250));
    }
    opts.onMetrics?.({
      buffer: this.hb.getMetrics(),
      mem: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed },
    });
  }

  stopAll() {
    // 실제 구현 시: 세션별 AbortController/자원 해제
    this.log.info('stopAll(stub)');
  }
}
