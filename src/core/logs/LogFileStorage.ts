// === src/core/logs/LogFileStorage.ts ===
import * as fs from 'fs';
import type { LogEntry } from '../../extension/messaging/messageTypes.js';
import { globalProfiler, measureIO } from '../logging/perf.js';

export class LogFileStorage {
  constructor(private filePath: string) {}

  // JSONL 기반 저장/조회
  @measureIO('writeFile', (instance) => instance.filePath)
  async append(e: LogEntry) {
    await fs.promises.appendFile(this.filePath, JSON.stringify(e) + '\n');
  }

  @measureIO('readFile', (instance) => instance.filePath)
  async range(fromTs: number, toTs: number): Promise<LogEntry[]> {
    const data = await fs.promises.readFile(this.filePath, 'utf8');
    const lines = data.split('\n').filter(line => line.trim());
    const entries: LogEntry[] = [];
    for (const line of lines) {
      try {
        const entry: LogEntry = JSON.parse(line);
        if (entry.ts >= fromTs && entry.ts <= toTs) {
          entries.push(entry);
        }
      } catch (e) {
        // Skip invalid lines
      }
    }
    return entries;
  }
}
