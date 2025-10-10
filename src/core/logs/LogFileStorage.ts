// === src/core/logs/LogFileStorage.ts ===
import type { LogEntry } from '../../extension/messaging/messageTypes.js';

export class LogFileStorage {
  // JSONL 기반 저장/조회 스텁
  async append(_e: LogEntry) {
    /* TODO */
  }
  async range(_fromTs: number, _toTs: number): Promise<LogEntry[]> {
    return [];
  }
}
