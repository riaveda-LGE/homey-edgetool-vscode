// === src/core/logs/PagedReader.ts ===
import type { LogEntry } from '@ipc/messages';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import { safeParseJson } from '../../shared/utils.js';
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

  static async open(manifestDir: string): Promise<PagedReader> {
    log.debug('[debug] PagedReader open: start');
    const mf = path.join(manifestDir, 'manifest.json');
    const buf = await fs.promises.readFile(mf, 'utf8');
    const json = JSON.parse(buf);
    if (!isLogManifest(json)) {
      throw new Error('Invalid manifest.json');
    }
    // 정합성 보장: 정렬
    json.chunks.sort((a, b) => a.start - b.start);
    const result = new PagedReader(manifestDir, json);
    log.debug('[debug] PagedReader open: end');
    return result;
  }

  getManifest(): Readonly<LogManifest> {
    log.debug('[debug] PagedReader getManifest: start');
    const result = this.manifest;
    log.debug('[debug] PagedReader getManifest: end');
    return result;
  }

  getTotalLines(): number | undefined {
    log.debug('[debug] PagedReader getTotalLines: start');
    const result = this.manifest.totalLines ?? this.manifest.mergedLines;
    log.debug('[debug] PagedReader getTotalLines: end');
    return result;
  }

  getPageCount(pageSize: number): number {
    log.debug('[debug] PagedReader getPageCount: start');
    const total = this.getTotalLines() ?? 0;
    if (total <= 0) return 0;
    const result = Math.ceil(total / Math.max(1, pageSize));
    log.debug('[debug] PagedReader getPageCount: end');
    return result;
  }

  /** 전역 라인 기준 page를 읽는다 (0-based pageIndex) */
  async readPage(
    pageIndex: number,
    pageSize: number,
    opts: PageReadOptions = {},
  ): Promise<LogEntry[]> {
    log.debug('[debug] PagedReader readPage: start');
    const size = Math.max(1, pageSize);
    const start = pageIndex * size;
    const endExcl = start + size;
    const result = await this.readLineRange(start, endExcl, opts);
    log.debug('[debug] PagedReader readPage: end');
    return result;
  }

  /** 전역 라인 인덱스 기준 [start, end) 범위를 읽기 */
  async readLineRange(
    start: number,
    endExcl: number,
    opts: PageReadOptions = {},
  ): Promise<LogEntry[]> {
    log.debug('[debug] PagedReader readLineRange: start');
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
    log.debug('[debug] PagedReader readLineRange: end');
    return out.length > need ? out.slice(0, need) : out;
  }

  private async _readChunkSlice(
    filePath: string,
    startLine: number, // 청크 내부 기준 0-based 포함
    endLineExcl: number, // 청크 내부 기준 0-based 미포함
    opts: PageReadOptions,
  ): Promise<LogEntry[]> {
    log.debug('[debug] PagedReader _readChunkSlice: start');
    const out: LogEntry[] = [];
    let idx = 0;

    const rs = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: rs });

    const onAbort = () => {
      try {
        rs.close();
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
    }

    log.debug('[debug] PagedReader _readChunkSlice: end');
    return out;
  }
}
