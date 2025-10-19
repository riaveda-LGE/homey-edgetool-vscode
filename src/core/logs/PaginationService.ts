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
  // ── Filter(호스트 적용) ────────────────────────────────────────────────
  private filter: { pid?: string; src?: string; proc?: string; msg?: string } | null = null;
  private filteredTotalCache?: number;
  private filteredCacheKey?: string;

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
    // 데이터셋 버전이 바뀌었으므로 필터 총계 캐시 무효화
    this.invalidateFilterCache();
  }

  getManifestDir() { return this.manifestDir; }
  getVersion() { return this.version; }
  isWarmupActive() { return this.warmActive; }
  getWarmTotal() { return this.warmTotal || (this.warmBuffer?.length ?? 0); }
  /** 파일 기반 모드일 때 추론 가능한 총 라인 수(없으면 undefined) */
  getFileTotal(): number | undefined {
    return this.reader?.getTotalLines();
  }
  /** 필터 상태 */
  isFilterActive() { return !!(this.filter && Object.values(this.filter).some(v => !!(v && String(v).trim()))); }
  getFilter() { return this.filter; }
  setFilter(f: { pid?: string; src?: string; proc?: string; msg?: string } | null) {
    const norm = this.normalizeFilter(f);
    const key = JSON.stringify(norm);
    const changed = key !== this.filteredCacheKey;
    this.filter = norm;
    if (changed) {
      this.invalidateFilterCache();
      this.version++; // UI가 구버전 응답을 버리도록 bump
      this.log.info(`pagination: filter set ${key}`);
    } else {
      this.log.debug?.('pagination: filter unchanged');
    }
  }
  /** 필터 활성 시 총 라인 수 계산 */
  async getFilteredTotal(): Promise<number | undefined> {
    if (!this.filter) {
      // 필터가 없으면 warm/file 총계를 그대로 반환
      return this.warmActive ? this.getWarmTotal() : (this.reader?.getTotalLines() ?? 0);
    }
    const key = JSON.stringify(this.filter) + `@v${this.version}`;
    if (this.filteredCacheKey === key && typeof this.filteredTotalCache === 'number') {
      this.log.debug?.(`pagination: filteredTotal(cache) key=${key} total=${this.filteredTotalCache}`);
      return this.filteredTotalCache;
    }
    // 1) 워밍업
    if (this.warmActive) {
      const total = (this.warmBuffer ?? []).filter(e => this.matchesFilter(e)).length;
      this.filteredCacheKey = key; this.filteredTotalCache = total;
      this.log.info(`pagination: filteredTotal(warm) total=${total}`);
      return total;
    }
    // 2) 파일 기반 — 창 단위로 전체 순회
    if (!this.reader) return 0;
    const totalLines = this.reader.getTotalLines() ?? 0;
    const WINDOW = 5000;
    let cnt = 0;
    for (let from = 0; from < totalLines; from += WINDOW) {
      const part = await this.reader.readLineRange(from, Math.min(totalLines, from + WINDOW), { skipInvalid: true });
      for (const e of part) if (this.matchesFilter(e)) cnt++;
    }
    this.filteredCacheKey = key; this.filteredTotalCache = cnt;
    this.log.info(`pagination: filteredTotal(file) total=${cnt}, lines=${totalLines}`);
    return cnt;
  }
  /** 브리지/패널에서 디버깅용으로 한 번에 읽어갈 수 있는 스냅샷 */
  getSnapshot() {
    return {
      version: this.version,
      manifestDir: this.manifestDir,
      warmActive: this.warmActive,
      warmTotal: this.getWarmTotal(),
      fileTotal: this.reader?.getTotalLines(),
      filter: this.filter || null,
    };
  }

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
    // 필터가 활성화된 경우에는 필터링 인덱스 공간 기준으로 읽음
    if (this.isFilterActive()) {
      return await this.readRangeFiltered(startIdx, endIdx);
    }
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

  /** 필터 활성 시, "필터 결과 인덱스" 기준으로 [startIdx,endIdx] 구간을 반환 */
  async readRangeFiltered(startIdx: number, endIdx: number): Promise<LogEntry[]> {
    if (startIdx > endIdx) return [];
    const want = Math.max(0, endIdx - startIdx + 1);
    const out: LogEntry[] = [];
    const matches = (e: LogEntry) => this.matchesFilter(e);

    // 1) 워밍업 버퍼
    if (this.warmActive) {
      const buf = (this.warmBuffer ?? []).filter(matches);
      const s0 = Math.max(0, startIdx - 1);
      return buf.slice(s0, s0 + want);
    }

    // 2) 파일 기반: 전체를 창(window) 단위로 순회하며 필요한 슬라이스만 수집
    if (!this.reader) throw new Error('PaginationService: manifest not set');
    const total = this.reader.getTotalLines() ?? 0;
    if (total <= 0) return [];

    const WINDOW = 2000; // 한 번에 읽을 라인 수(튜닝 가능)
    let virtualCount = 0; // 필터에 매칭된 누적 카운트

    for (let from = 0; from < total; from += WINDOW) {
      const part = await this.reader.readLineRange(from, Math.min(total, from + WINDOW), { skipInvalid: true });
      for (const e of part) {
        if (!matches(e)) continue;
        virtualCount++;
        if (virtualCount < startIdx) continue;      // 아직 시작 전
        out.push(e);
        if (out.length >= want) return out;         // 충분히 모았으면 종료
      }
    }
    return out;
  }

  private normalizeFilter(f: any) {
    const s = (v:any)=> String(v ?? '').trim();
    const norm = {
      pid:  s(f?.pid),
      src:  s(f?.src),
      proc: s(f?.proc),
      msg:  s(f?.msg),
    };
    // 전부 빈 문자열이면 null 취급(필터 미적용)
    if (!norm.pid && !norm.src && !norm.proc && !norm.msg) return null;
    return norm;
  }
  private invalidateFilterCache() {
    this.filteredTotalCache = undefined;
    this.filteredCacheKey = this.filter ? JSON.stringify(this.filter) : undefined;
  }

  private matchesFilter(e: LogEntry): boolean {
    if (!this.filter) return true;
    const f = this.filter;
    const parsed = this.parseLine(String(e.text || ''));
    const msg  = String(parsed.msg  || '').toLowerCase();
    const proc = String(parsed.proc || '').toLowerCase();
    const pid  = String(parsed.pid  || '').toLowerCase();
    const src  = String(e.source    || '').toLowerCase();
    const has = (s?: string) => !!(s && s.trim());
    if (has(f.msg)  && !msg.includes(String(f.msg).toLowerCase()))   return false;
    if (has(f.proc) && !proc.includes(String(f.proc).toLowerCase())) return false;
    if (has(f.pid)  && !pid.includes(String(f.pid).toLowerCase()))   return false;
    if (has(f.src)  && !src.includes(String(f.src).toLowerCase()))    return false;
    return true;
  }

  /** UI와 동일한 규칙으로 한 줄을 proc/pid/msg로 파싱 */
  private parseLine(line: string){
    const timeMatch = line.match(/^\[([^\]]+)\]\s+(.*)$/);
    let rest = line;
    if (timeMatch){ rest = timeMatch[2]; }
    const procMatch = rest.match(/^([^\s:]+)\[(\d+)\]:\s*(.*)$/);
    let proc='', pid='', msg=rest;
    if (procMatch){ proc = procMatch[1]; pid = procMatch[2]; msg = procMatch[3] ?? ''; }
    return { proc, pid, msg };
  }

  // ── Back-compat: 과거 호출명 호환용 래퍼 ────────────────────────────────
  /** 옛 호출자를 위한 호환 래퍼. 현재 필터 기준 상단 N개와 총계를 반환 */
  async readHeadFiltered(limit = 500): Promise<{ rows: LogEntry[]; total: number }> {
    const total = await this.getFilteredTotal();
    const endIdx = Math.max(1, Math.min(limit, total || limit));
    const rows = await this.readRangeByIdx(1, endIdx);
    return { rows, total: total ?? 0 };
  }
  /** 옛 호출자를 위한 호환 래퍼. 현재 필터 해제 */
  clearFilter() { this.setFilter(null); }
}

export const paginationService = new PaginationService();
