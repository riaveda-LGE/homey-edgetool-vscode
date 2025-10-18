// === src/core/logs/PaginationService.ts ===
import type { LogEntry } from '@ipc/messages';
import { getLogger } from '../logging/extension-logger.js';
import { PagedReader } from './PagedReader.js';

class PaginationService {
  private manifestDir?: string;
  private reader?: PagedReader;
  private log = getLogger('PaginationService');
  private version = 0; // manifest/리더 재로딩 버전
  // ── Warmup (메모리 기반 페이지) ─────────────────────────────────────────
  private warmActive = false;
  private warmBuffer: LogEntry[] | null = null;   // 최신순(내림차순) 0..N-1
  private warmTotal = 0;                          // 가상 total(예: 2000)

  async setManifestDir(dir: string) {
    if (this.manifestDir !== dir) {
      this.log.info(`pagination: open dir=${dir}`);
      this.reader = await PagedReader.open(dir);
      this.manifestDir = dir;
      this.version++;
    } else {
      this.log.debug?.(`pagination: already set dir=${dir}`);
    }
    // ⚠️ 워밍업 모드는 여기서 유지 — 최종 T1 완료(reload) 때 파일 기반으로 스위치
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
    // 파일 기반 준비 끝 → 이제 warm 모드 종료
    this.clearWarmup();
  }

  getManifestDir() { return this.manifestDir; }
  getVersion() { return this.version; }
  isWarmupActive() { return this.warmActive; }
  getWarmTotal() { return this.warmTotal || (this.warmBuffer?.length ?? 0); }

  /** 워밍업(메모리) 버퍼 시드 — 최신순 배열과 가상 total 수치 */
  seedWarmupBuffer(entries: LogEntry[], virtualTotal: number) {
    this.warmBuffer = entries?.slice?.() ?? [];
    this.warmTotal = Math.max(this.warmBuffer.length, virtualTotal || 0);
    this.warmActive = (this.warmBuffer.length > 0);
    this.version++;
    this.log.info(`pagination: warmup seeded entries=${this.warmBuffer.length} virtualTotal=${this.warmTotal}`);
  }

  clearWarmup() {
    if (!this.warmActive) return;
    const n = this.warmBuffer?.length ?? 0;
    this.warmBuffer = null;
    this.warmTotal = 0;
    this.warmActive = false;
    this.version++;
    this.log.info(`pagination: warmup cleared (released ${n} entries)`);
  }

  /** 1-based inclusive 인덱스 범위를 읽어온다. */
  async readRangeByIdx(startIdx: number, endIdx: number): Promise<LogEntry[]> {
    // ── 워밍업 메모리 모드: 파일 리더가 없어도 슬라이스 제공 ─────────────
    if (this.warmActive) {
      const buf = this.warmBuffer ?? [];
      if (startIdx > endIdx || endIdx <= 0) {
        this.log.warn(`pagination(warm): invalid range ${startIdx}-${endIdx}`);
        return [];
      }
      // 최신=1 기준. 내부 배열은 최신이 index 0
      const start0 = Math.max(0, startIdx - 1);
      const endExcl = Math.min(buf.length, Math.max(start0, endIdx));
      const slice = buf.slice(start0, endExcl);
      // idx 보정(없으면 채워줌)
      for (let i = 0; i < slice.length; i++) {
        const e = slice[i] as any;
        if (typeof e.idx !== 'number') e.idx = start0 + 1 + i;
      }
      this.log.debug?.(`pagination(warm): read ${startIdx}-${endIdx} -> ${slice.length}`);
      return slice as LogEntry[];
    }

    // ── 파일 기반 모드 ───────────────────────────────────────────────────
    if (!this.reader) {
      const err = 'PaginationService: manifest not set (no warm buffer)';
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
