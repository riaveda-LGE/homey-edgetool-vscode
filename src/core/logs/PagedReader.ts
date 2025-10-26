// === src/core/logs/PagedReader.ts ===
import type { LogEntry } from '@ipc/messages';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import { safeParseJson } from '../../shared/utils.js';
import { measure } from '../logging/perf.js';
import type { LogManifest } from './ManifestTypes.js';
import { isLogManifest } from './ManifestTypes.js';
import { getLogger } from '../logging/extension-logger.js';

const log = getLogger('PagedReader');

export type PageReadOptions = {
  signal?: AbortSignal;
  skipInvalid?: boolean; // 기본 true
};

export class PagedReader {
  private constructor(
    private dir: string,
    private manifest: LogManifest,
  ) {}

  @measure()
  static async open(manifestDir: string): Promise<PagedReader> {
    const mf = path.join(manifestDir, 'manifest.json');
    const buf = await fs.promises.readFile(mf, 'utf8');
    const json = JSON.parse(buf);
    if (!isLogManifest(json)) {
      throw new Error('Invalid manifest.json');
    }
    // 정합성 보장: 정렬 + mergedLines 재계산(마지막 청크 기준)
    json.chunks.sort((a, b) => a.start - b.start);
    if (json.chunks.length > 0) {
      const last = json.chunks[json.chunks.length - 1];
      const derived = last.start + last.lines;
      if (json.mergedLines !== derived) {
        // 파일에는 그대로 두고 메모리상으로만 보정해 사용
        log.debug?.(
          `manifest: mergedLines corrected in-memory ${json.mergedLines} -> ${derived}`,
        );
        (json as any).mergedLines = derived;
      }
    }
    const result = new PagedReader(manifestDir, json);
    return result;
  }

  getManifest(): Readonly<LogManifest> {
    const result = this.manifest;
    return result;
  }

  getTotalLines(): number | undefined {
    // ⚠️ 실제 읽기 가능한 커버리지는 mergedLines가 유일하게 정확함.
    // totalLines는 추정치(사전 계산)일 수 있어 더 클 수 있다.
    const merged = this.manifest.mergedLines;
    if (typeof merged === 'number' && merged > 0) return merged;
    return this.manifest.totalLines;
  }

  getPageCount(pageSize: number): number {
    const total = this.getTotalLines() ?? 0;
    if (total <= 0) return 0;
    const result = Math.ceil(total / Math.max(1, pageSize));
    return result;
  }

  @measure()
  async readPage(
    pageIndex: number,
    pageSize: number,
    opts: PageReadOptions = {},
  ): Promise<LogEntry[]> {
    const size = Math.max(1, pageSize);
    const start = pageIndex * size;
    const endExcl = start + size;
    const result = await this.readLineRange(start, endExcl, opts);
    return result;
  }

  @measure()
  async readLineRange(
    start: number,
    endExcl: number,
    opts: PageReadOptions = {},
  ): Promise<LogEntry[]> {
    const out: LogEntry[] = [];
    if (endExcl <= start) return out;

    const skipInvalid = opts.skipInvalid ?? true;
    const need = endExcl - start;

    // 범위와 겹치는 청크만 골라 읽기
    for (const c of this.manifest.chunks) {
      const cStart = c.start;
      const cEndExcl = c.start + c.lines;
      if (cEndExcl <= start || cStart >= endExcl) continue; // 겹치지 않음

      const takeFrom = Math.max(0, start - cStart);
      const takeToExcl = Math.min(c.lines, endExcl - cStart);
      const partPath = path.join(this.dir, c.file);

      const picked = await this._readChunkSlice(partPath, takeFrom, takeToExcl, {
        signal: opts.signal,
        skipInvalid,
      });
      out.push(...picked);
      if (out.length >= need) break;
    }
    return out.length > need ? out.slice(0, need) : out;
  }

  @measure()
  private async _readChunkSlice(
    filePath: string,
    startLine: number, // 청크 내부 기준 0-based 포함
    endLineExcl: number, // 청크 내부 기준 0-based 미포함
    opts: PageReadOptions,
  ): Promise<LogEntry[]> {
    const out: LogEntry[] = [];
    let idx = 0;

    const rs = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: rs });

    const onAbort = () => {
      try {
        // 스트림과 인터페이스를 모두 종료하여 핸들 누수 방지
        rl.close();
        (rs as any).destroy?.();
        (rs as any).close?.();
      } catch {}
    };
    opts.signal?.addEventListener('abort', onAbort);

    try {
      for await (const line of rl) {
        if (idx >= endLineExcl) break;
        if (idx >= startLine) {
          const trimmed = String(line || '').trim();
          if (trimmed) {
            try {
              const e = safeParseJson<LogEntry>(trimmed);
              if (e) out.push(e);
            } catch (e) {
              if (!opts.skipInvalid) throw e;
            }
          }
        }
        idx++;
        if (opts.signal?.aborted) break;
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      try {
        // 정상/에러/abort 어떤 경로든 인터페이스/스트림을 명시적으로 닫아 핸들 누수 방지
        rl.close();
        (rs as any).destroy?.();
        (rs as any).close?.();
      } catch {}
    }
    return out;
  }
}
