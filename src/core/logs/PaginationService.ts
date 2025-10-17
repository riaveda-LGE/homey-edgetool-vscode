// === src/core/logs/PaginationService.ts ===
import type { LogEntry } from '../../extension/messaging/messageTypes.js';
import { getLogger } from '../logging/extension-logger.js';
import { PagedReader } from './PagedReader.js';

class PaginationService {
  private manifestDir?: string;
  private reader?: PagedReader;
  private log = getLogger('PaginationService');

  async setManifestDir(dir: string) {
    if (this.manifestDir !== dir) {
      this.log.info(`pagination: open dir=${dir}`);
      this.reader = await PagedReader.open(dir);
      this.manifestDir = dir;
    } else {
      this.log.debug?.(`pagination: already set dir=${dir}`);
    }
  }

  getManifestDir() { return this.manifestDir; }

  /** 1-based inclusive 인덱스 범위를 읽어온다. */
  async readRangeByIdx(startIdx: number, endIdx: number): Promise<LogEntry[]> {
    if (!this.reader) {
      const err = 'PaginationService: manifest not set';
      this.log.error(err);
      throw new Error(err);
    }
    if (startIdx > endIdx) {
      this.log.warn(`pagination: invalid range ${startIdx}-${endIdx}`);
      return [];
    }
    const start0 = Math.max(0, startIdx - 1);
    const endExcl = Math.max(start0, endIdx); // [S-1, E) (E inclusive → exclusive로 사용)
    const rows = await this.reader.readLineRange(start0, endExcl, { skipInvalid: true });
    this.log.debug?.(`pagination: read ${startIdx}-${endIdx} -> ${rows.length}`);
    return rows;
  }
}

export const paginationService = new PaginationService();
