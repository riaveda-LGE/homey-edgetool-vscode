import type { LogEntry } from '../../extension/messaging/messageTypes.js';
import { ConnectionManager, type HostConfig } from '../connection/ConnectionManager.js';
import { getLogger } from '../logging/extension-logger.js';
import { XError, ErrorCategory } from '../../shared/errors.js';
import { measure } from '../logging/perf.js';
import { HybridLogBuffer } from '../logs/HybridLogBuffer.js';
import { mergeDirectory } from '../logs/LogFileIntegration.js';
import { DEFAULT_BATCH_SIZE } from '../../shared/const.js';

export type SessionCallbacks = {
  onBatch: (logs: LogEntry[], total?: number, seq?: number) => void;
  onMetrics?: (m: { buffer: any; mem: { rss: number; heapUsed: number } }) => void;
};

export class LogSessionManager {
  private log = getLogger('LogSessionManager');
  private hb = new HybridLogBuffer();
  private seq = 0;
  private rtAbort?: AbortController;
  private cm?: ConnectionManager; // 연결 관리자 추적

  constructor(private conn?: HostConfig) {}

  @measure()
  async startRealtimeSession(opts: { signal?: AbortSignal; filter?: string } & SessionCallbacks) {
    this.log.info('startRealtimeSession');
    if (!this.conn) throw new XError(ErrorCategory.Connection, 'No connection configured');

    this.cm = new ConnectionManager(this.conn);
    await this.cm.connect();

    this.rtAbort = new AbortController();
    if (opts.signal) opts.signal.addEventListener('abort', () => this.rtAbort?.abort());

    const filter = (s: string) => {
      const f = opts.filter?.trim();
      return !f || s.toLowerCase().includes(f.toLowerCase());
    };

    // 커맨드 선택
    const cmd =
      this.conn.type === 'adb'
        ? `logcat -v time`
        : `sh -lc 'journalctl -f -o short-iso -n 0 -u "homey*" 2>/dev/null || docker ps --format "{{.Names}}" | awk "/homey/{print}" | xargs -r -n1 docker logs -f --since 0s'`;

    await this.cm.stream(
      cmd,
      (line) => {
        if (!filter(line)) return;
        const e: LogEntry = {
          id: Date.now(),
          ts: Date.now(),
          level: 'I',
          type: 'system',
          source: this.conn!.type,
          text: line,
        };
        this.hb.add(e);
        opts.onBatch([e], undefined, ++this.seq);
        opts.onMetrics?.({
          buffer: this.hb.getMetrics(),
          mem: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed },
        });
      },
      this.rtAbort.signal,
    );
  }

  @measure()
  async startFileMergeSession(opts: { dir: string; signal?: AbortSignal } & SessionCallbacks) {
    this.log.info(`startFileMergeSession dir=${opts.dir}`);
    let seq = 0;
    await mergeDirectory({
      dir: opts.dir,
      reverse: false,
      signal: opts.signal,
      batchSize: DEFAULT_BATCH_SIZE,
      onBatch: (logs) => {
        this.hb.addBatch(logs);
        opts.onBatch(logs, undefined, ++seq);
        opts.onMetrics?.({
          buffer: this.hb.getMetrics(),
          mem: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed },
        });
      },
    });
  }

  @measure()
  stopAll() {
    this.log.info('stopAll');
    this.rtAbort?.abort();
    this.cm?.dispose(); // 연결 정리
  }

  dispose() {
    this.stopAll();
    this.cm?.dispose();
    this.hb?.clear();
  }
}
