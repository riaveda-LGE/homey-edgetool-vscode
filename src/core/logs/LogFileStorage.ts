// === src/core/logs/LogFileStorage.ts ===
import * as fs from 'fs';

import type { LogEntry } from '../../extension/messaging/messageTypes.js';
import { safeParseJson } from '../../shared/utils.js';
import { globalProfiler, measureIO } from '../logging/perf.js';

export interface ILogFileStorage {
  append(entry: LogEntry, options?: AppendOptions): Promise<void>;
  range(fromTs: number, toTs: number, options?: RangeOptions): Promise<LogEntry[]>;
}

export type AppendOptions = {
  flush?: boolean; // 즉시 flush 여부
};

export type RangeOptions = {
  limit?: number; // 최대 반환 개수
  skipInvalid?: boolean; // 유효하지 않은 라인 스킵 (기본 true)
};

export class LogFileStorage implements ILogFileStorage {
  constructor(private filePath: string) {}

  // JSONL 기반 저장/조회
  @measureIO('writeFile', (instance) => instance.filePath)
  async append(e: LogEntry, options?: AppendOptions) {
    const data = JSON.stringify(e) + '\n';
    if (options?.flush) {
      await fs.promises.appendFile(this.filePath, data, { flush: true });
    } else {
      await fs.promises.appendFile(this.filePath, data);
    }
  }

  @measureIO('readFile', (instance) => instance.filePath)
  async range(fromTs: number, toTs: number, options?: RangeOptions): Promise<LogEntry[]> {
    const data = await fs.promises.readFile(this.filePath, 'utf8');
    const lines = data.split('\n').filter(line => line.trim());
    const entries: LogEntry[] = [];
    const limit = options?.limit ?? Infinity;
    const skipInvalid = options?.skipInvalid ?? true;

    for (const line of lines) {
      if (entries?.length >= limit) break;
      try {
        const entry = safeParseJson<LogEntry>(line);
        if (entry && entry.ts >= fromTs && entry.ts <= toTs) {
          entries.push(entry);
        }
      } catch (e) {
        if (!skipInvalid) {
          throw e;
        }
        // Skip invalid lines
      }
    }
    return entries;
  }
}
