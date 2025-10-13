// === src/core/logs/LogFileStorage.ts ===
import type { LogEntry } from '../../extension/messaging/messageTypes.js';
import { globalProfiler } from '../logging/perf.js';

export class LogFileStorage {
  // JSONL 기반 저장/조회 스텁
  async append(_e: LogEntry) {
    // TODO: 실제 구현 시 I/O 측정 적용
    // await globalProfiler.measureIO('writeFile', filePath, async () => {
    //   await fs.promises.appendFile(filePath, JSON.stringify(_e) + '\n');
    // });
  }

  async range(_fromTs: number, _toTs: number): Promise<LogEntry[]> {
    // TODO: 실제 구현 시 I/O 측정 적용
    // return await globalProfiler.measureIO('readFile', filePath, async () => {
    //   const data = await fs.promises.readFile(filePath, 'utf8');
    //   return data.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    // });
    return [];
  }
}
