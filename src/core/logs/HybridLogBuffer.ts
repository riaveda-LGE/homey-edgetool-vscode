// === src/core/logs/HybridLogBuffer.ts ===
import type { LogEntry } from '../../extension/messaging/messageTypes.js';
import { getLogger } from '../logging/extension-logger.js';
import { REALTIME_BUFFER_MAX } from '../../shared/const.js';

export type BufferMetrics = { realtime: number; viewport: number; search: number; spill: number };

export interface IHybridLogBuffer {
  getMetrics(): BufferMetrics;
  add(entry: LogEntry): void;
  addBatch(entries: LogEntry[]): void;
  clear(): void;
  snapshot(count?: number): LogEntry[];
}

export class HybridLogBuffer implements IHybridLogBuffer {
  private log = getLogger('HybridLogBuffer');
  private realtime: LogEntry[] = [];
  // viewport/search/spill은 나중에 확장. 지금은 뼈대만.
  getMetrics(): BufferMetrics {
    return { realtime: this.realtime.length, viewport: 0, search: 0, spill: 0 };
  }
  add(entry: LogEntry) {
    this.realtime.push(entry);
    if (this.realtime.length > REALTIME_BUFFER_MAX) this.realtime.shift();
  }
  addBatch(entries: LogEntry[]) {
    for (const e of entries) this.add(e);
  }
  clear() {
    this.realtime = [];
  }
  snapshot(count = 50): LogEntry[] {
    return this.realtime.slice(-count);
  }
}
