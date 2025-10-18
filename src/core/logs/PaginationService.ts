// === src/core/logs/PaginationService.ts ===
import type { LogEntry } from '@ipc/messages';
import { getLogger } from '../logging/extension-logger.js';
import { PagedReader } from './PagedReader.js';

class PaginationService {
  private manifestDir?: string;
  private reader?: PagedReader;
  private log = getLogger('PaginationService');
  private version = 0; // manifest/리더 재로딩 버전

  async setManifestDir(dir: string) {
    if (this.manifestDir !== dir) {
      this.log.info(`pagination: open dir=${dir}`);
      this.reader = await PagedReader.open(dir);
      this.manifestDir = dir;
      this.version++;
    } else {
      this.log.debug?.(`pagination: already set dir=${dir}`);
    }
  }

  /** T1 완료 후 최신 manifest로 다시 열기 */
  async reload() {
    if (!this.manifestDir) {
      this.log.warn('pagination: reload requested without manifestDir');
      return;
    }
    this.log.info(`pagination: reload dir=${this.manifestDir}`);
    this.reader = await PagedReader.open(this.manifestDir);
    this.version++;
  }

  getManifestDir() { return this.manifestDir; }
  getVersion() { return this.version; }

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
