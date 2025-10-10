import type { LogEntry } from '../../extension/messaging/messageTypes.js';
import { getLogger } from '../logging/extension-logger.js';
import { HybridLogBuffer } from '../logs/HybridLogBuffer.js';
import { ConnectionManager, type HostConfig } from '../connection/ConnectionManager.js';
import { mergeDirectory } from '../logs/LogFileIntegration.js';

export type SessionCallbacks = {
  onBatch: (logs: LogEntry[], total?: number, seq?: number) => void;
  onMetrics?: (m: { buffer: any; mem: { rss: number; heapUsed: number } }) => void;
};

export class LogSessionManager {
  private log = getLogger('LogSessionManager');
  private hb = new HybridLogBuffer();
  private seq = 0;
  private rtAbort?: AbortController;

  constructor(private conn?: HostConfig) {}

  async startRealtimeSession(opts: { signal?: AbortSignal; filter?: string } & SessionCallbacks) {
    this.log.info('startRealtimeSession');
    if (!this.conn) throw new Error('No connection configured');

    const cm = new ConnectionManager(this.conn);
    await cm.connect();

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

    await cm.stream(
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

  async startFileMergeSession(opts: { dir: string; signal?: AbortSignal } & SessionCallbacks) {
    this.log.info(`startFileMergeSession dir=${opts.dir}`);
    let seq = 0;
    await mergeDirectory({
      dir: opts.dir,
      reverse: false,
      signal: opts.signal,
      batchSize: 200,
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

  stopAll() {
    this.log.info('stopAll');
    this.rtAbort?.abort();
  }
}
