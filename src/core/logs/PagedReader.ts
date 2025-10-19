// === src/core/logs/PagedReader.ts ===
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import type { LogEntry } from '@ipc/messages';
import { safeParseJson } from '../../shared/utils.js';
import type { LogManifest } from './ManifestTypes.js';
import { isLogManifest } from './ManifestTypes.js';

export type PageReadOptions = {
  signal?: AbortSignal;
  skipInvalid?: boolean; // 기본 true
};

export class PagedReader {
  private constructor(private dir: string, private manifest: LogManifest) {}

  static async open(manifestDir: string): Promise<PagedReader> {
    const mf = path.join(manifestDir, 'manifest.json');
    const buf = await fs.promises.readFile(mf, 'utf8');
    const json = JSON.parse(buf);
    if (!isLogManifest(json)) {
      throw new Error('Invalid manifest.json');
    }
    // 정합성 보장: 정렬
    json.chunks.sort((a, b) => a.start - b.start);
    return new PagedReader(manifestDir, json);
  }

  getManifest(): Readonly<LogManifest> {
    return this.manifest;
  }

  getTotalLines(): number | undefined {
    return this.manifest.totalLines ?? this.manifest.mergedLines;
  }

  getPageCount(pageSize: number): number {
    const total = this.getTotalLines() ?? 0;
    if (total <= 0) return 0;
    return Math.ceil(total / Math.max(1, pageSize));
  }

  /** 전역 라인 기준 page를 읽는다 (0-based pageIndex) */
  async readPage(pageIndex: number, pageSize: number, opts: PageReadOptions = {}): Promise<LogEntry[]> {
    const size = Math.max(1, pageSize);
    const start = pageIndex * size;
    const endExcl = start + size;
    return await this.readLineRange(start, endExcl, opts);
  }

  /** 전역 라인 인덱스 기준 [start, end) 범위를 읽기 */
  async readLineRange(start: number, endExcl: number, opts: PageReadOptions = {}): Promise<LogEntry[]> {
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
      try { rs.close(); } catch {}
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
    }

    return out;
  }
}
