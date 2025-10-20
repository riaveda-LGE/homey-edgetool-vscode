// === src/core/logs/LogFileStorage.ts ===
import type { LogEntry } from '@ipc/messages';
import * as fs from 'fs';

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
    console.log('Appending data:', data); // 디버깅 로그 추가
    if (options?.flush) {
      // Node의 appendFile에는 flush 옵션이 없음 → 파일핸들 열고 sync로 보장
      const fh = await fs.promises.open(this.filePath, 'a');
      try {
        await fh.appendFile(data);
        await fh.sync(); // 디스크 동기화
      } finally {
        await fh.close();
      }
    } else {
      await fs.promises.appendFile(this.filePath, data);
    }
  }

  @measureIO('readFile', (instance) => instance.filePath)
  async range(fromTs: number, toTs: number, options?: RangeOptions): Promise<LogEntry[]> {
    // 대용량에서도 안전하게 동작하도록 스트리밍으로 변경
    const limit = options?.limit ?? Infinity;
    const skipInvalid = options?.skipInvalid ?? true;
    const out: LogEntry[] = [];

    await new Promise<void>((resolve, reject) => {
      const rs = fs.createReadStream(this.filePath, { encoding: 'utf8' });
      let residual = '';
      const closeEarly = () => {
        try {
          // destroy/close 중 하나만 호출
          (rs as any).destroy?.();
          (rs as any).close?.();
        } catch {}
      };

      rs.on('data', (chunk: string | Buffer) => {
        if (out.length >= limit) return;
        const text = residual + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
        const parts = text.split(/\r?\n/);
        residual = parts.pop() ?? '';
        for (const line of parts) {
          if (out.length >= limit) break;
          if (!line.trim()) continue;
          try {
            const entry = safeParseJson<LogEntry>(line);
            if (entry && entry.ts >= fromTs && entry.ts <= toTs) {
              out.push(entry);
              if (out.length >= limit) {
                closeEarly();
                break;
              }
            }
          } catch (e) {
            if (!skipInvalid) {
              closeEarly();
              reject(e);
              return;
            }
            // invalid line skip
          }
        }
      });
      rs.on('end', () => {
        if (out.length < limit && residual.trim()) {
          try {
            const entry = safeParseJson<LogEntry>(residual);
            if (entry && entry.ts >= fromTs && entry.ts <= toTs) out.push(entry);
          } catch (e) {
            if (!skipInvalid) {
              reject(e);
              return;
            }
          }
        }
        resolve();
      });
      rs.on('error', (err) => reject(err));
    });

    return out;
  }
}
