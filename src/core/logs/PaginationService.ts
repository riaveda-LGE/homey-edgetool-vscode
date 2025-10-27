// === src/core/logs/PaginationService.ts ===
import type { LogEntry } from '@ipc/messages';

import { getLogger } from '../logging/extension-logger.js';
import { PagedReader } from './PagedReader.js';

class PaginationService {
  private manifestDir?: string;
  private reader?: PagedReader;
  private log = getLogger('PaginationService');
  private version = 0; // manifest/리더 재로딩 버전
  private bump(reason: string) {
    const prev = this.version;
    this.version++;
    // ⬇️ 디버그: 버전 변경 이유 및 이전→이후 값을 남겨 세션 불일치(drop) 원인 추적
    this.log.debug?.(`pagination.bump v${prev}→v${this.version} reason=${reason}`);
  }
  // ── Warmup (메모리 기반 페이지) ─────────────────────────────────────────
  private warmActive = false;
  private warmBuffer: LogEntry[] | null = null; // 최신→오래된(내림차순) 0..N-1 (물리)
  private warmTotal = 0; // 가상 total(예: 2000)
  // ── Filter(호스트 적용) ────────────────────────────────────────────────
  private filter: { pid?: string; src?: string; proc?: string; msg?: string } | null = null;
  private filteredTotalCache?: number;
  private filteredCacheKey?: string;
  // (참고) 기능 변경 없음. 로깅/버전 관리/캐시 무효화는 Host에서 refresh를 보냄으로써 보완됨.

  async setManifestDir(dir: string) {
    if (this.manifestDir !== dir) {
      // quiet
      this.reader = await PagedReader.open(dir);
      this.manifestDir = dir;
      this.bump('setManifestDir');
      this.invalidateFilterCache();
      // quiet
    } else {
      // quiet
    }
    // ⚠️ 워밍업 모드는 여기서 유지 — 최종 T1 완료(reload) 때 파일 기반으로 스위치
  }

  /** T1 완료 후 최신 manifest로 다시 열기 */
  async reload() {
    if (!this.manifestDir) {
      this.log.warn('pagination: reload requested without manifestDir');
      return;
    }
    // ⚠️ 전환 레이스 방지: 먼저 warm 모드를 끄고 그 다음 파일 리더를 연다.
    //    (이 순서를 바꾸면 warm 경로가 범위를 벗어난 요청에 대해 1줄만 반환하는
    //     문제가 발생할 수 있음)
    this.clearWarmup();
    this.reader = await PagedReader.open(this.manifestDir);
    this.bump('reload');
    // 데이터셋 버전이 바뀌었으므로 필터 총계 캐시 무효화
    this.invalidateFilterCache();
  }

  getManifestDir() {
    return this.manifestDir;
  }
  getVersion() {
    return this.version;
  }
  isWarmupActive() {
    return this.warmActive;
  }
  getWarmTotal() {
    return this.warmTotal || (this.warmBuffer?.length ?? 0);
  }
  /** 파일 기반 모드일 때 추론 가능한 총 라인 수(없으면 undefined) */
  getFileTotal(): number | undefined {
    // 추정치(totalLines) 대신 실제 저장된 라인 수(mergedLines)를 우선 사용
    try {
      const mf = (this.reader as any)?.getManifest?.();
      if (typeof mf?.mergedLines === 'number') return mf.mergedLines;
    } catch {}
    return this.reader?.getTotalLines();
  }
  /** 필터 상태 */
  isFilterActive() {
    return !!(this.filter && Object.values(this.filter).some((v) => !!(v && String(v).trim())));
  }
  getFilter() {
    return this.filter;
  }
  setFilter(f: { pid?: string; src?: string; proc?: string; msg?: string } | null) {
    const norm = this.normalizeFilter(f);
    const prevKey = this.filter ? JSON.stringify(this.filter) : undefined;
    const nextKey = norm ? JSON.stringify(norm) : undefined;
    const changed = prevKey !== nextKey;
    this.filter = norm;
    if (changed) {
      this.log.debug?.(
        `pagination.filter.set changed=true prev=${prevKey ?? '∅'} next=${nextKey ?? '∅'}`,
      );
      this.invalidateFilterCache('filter.set');
      this.bump('filter.set'); // 실제 변경시에만 bump
    } else {
      this.log.debug?.(`pagination.filter.set no-change key=${nextKey ?? '∅'}`);
    }
  }
  /** 필터 활성 시 총 라인 수 계산 */
  async getFilteredTotal(): Promise<number | undefined> {
    if (!this.filter) {
      // 필터가 없으면 warm/file 총계를 그대로 반환
      return this.warmActive ? this.getWarmTotal() : (this.getFileTotal() ?? 0);
    }
    // 캐시 키는 "필터 + 데이터셋 버전 + 모드(warm/file)"로 구성
    const baseKey = JSON.stringify(this.filter);
    const key = `${baseKey}@v${this.version}${this.warmActive ? ':warm' : ':file'}`;
    if (this.filteredCacheKey === key && typeof this.filteredTotalCache === 'number') {
      this.log.debug?.(
        `pagination.filter.total cache-hit key=${key} total=${this.filteredTotalCache}`,
      );
      return this.filteredTotalCache;
    }
    // 1) 워밍업
    if (this.warmActive) {
      const total = (this.warmBuffer ?? []).filter((e) => this.matchesFilter(e)).length;
      this.filteredCacheKey = key;
      this.filteredTotalCache = total;
      this.log.debug?.(`pagination.filter.total(warm) key=${key} total=${total}`);
      return total;
    }
    // 2) 파일 기반 — 창 단위로 전체 순회
    if (!this.reader) return 0;
    const totalLines = this.getFileTotal() ?? 0;
    const WINDOW = 5000;
    let cnt = 0;
    for (let from = 0; from < totalLines; from += WINDOW) {
      const part = await this.reader.readLineRange(from, Math.min(totalLines, from + WINDOW), {
        skipInvalid: true,
      });
      for (const e of part) if (this.matchesFilter(e)) cnt++;
    }
    this.filteredCacheKey = key;
    this.filteredTotalCache = cnt;
    this.log.debug?.(`pagination.filter.total(file) key=${key} total=${cnt} scanned=${totalLines}`);
    return cnt;
  }
  /** 브리지/패널에서 디버깅용으로 한 번에 읽어갈 수 있는 스냅샷 */
  getSnapshot() {
    return {
      version: this.version,
      manifestDir: this.manifestDir,
      warmActive: this.warmActive,
      warmTotal: this.getWarmTotal(),
      fileTotal: this.getFileTotal(),
      filter: this.filter || null,
    };
  }

  /** 워밍업(메모리) 버퍼 시드 — 최신순 배열과 가상 total 수치 */
  seedWarmupBuffer(entries: LogEntry[], virtualTotal: number) {
    this.warmBuffer = entries?.slice?.() ?? [];
    this.warmTotal = Math.max(this.warmBuffer.length, virtualTotal || 0);
    this.warmActive = this.warmBuffer.length > 0;
    this.bump('warm.seed');
    // quiet
  }

  clearWarmup() {
    if (!this.warmActive) return;
    const n = this.warmBuffer?.length ?? 0;
    this.warmBuffer = null;
    this.warmTotal = 0;
    this.warmActive = false;
    this.pendingWarned = false; // 파일 기반으로 전환되면 경고 상태 초기화
    this.bump('warm.clear');
    // quiet
  }

  // 초기 그리드-점프 시 warm/manifest가 아직 준비되지 않은 경우의 과도기 경고 억제용
  private pendingWarned = false;

  /** 1-based inclusive 인덱스 범위를 읽어온다. */
  async readRangeByIdx(startIdx: number, endIdx: number): Promise<LogEntry[]> {
    // 필터가 활성화된 경우에는 필터링 인덱스(오름차순) 공간 기준으로 읽음
    if (this.isFilterActive()) {
      return await this.readRangeFiltered(startIdx, endIdx);
    }
    // ── 워밍업 메모리 모드: 파일 리더가 없어도 슬라이스 제공 ─────────────
    //     단, warm 총량을 초과하는 범위가 요청되면 1줄로 클램프하지 말고
    //     파일 기반(가능 시)으로 폴백하거나 빈 배열을 반환한다.
    if (this.warmActive) {
      const buf = this.warmBuffer ?? [];
      if (startIdx > endIdx || endIdx <= 0) {
        this.log.warn(`pagination(warm): invalid range ${startIdx}-${endIdx}`);
        return [];
      }
      const N = buf.length;
      if (N === 0) {
        // warm은 활성인데 버퍼가 비었다면 파일 기반으로 폴백 시도
        if (!this.reader) return [];
        // fallthrough → 파일 기반 분기
      } else {
        // 요청 구간이 warm 총량을 완전히 벗어난 경우
        if (startIdx > N && endIdx > N) {
          if (this.reader) {
            this.log.debug?.(
              `pagination(warm): out-of-range ${startIdx}-${endIdx} (N=${N}) → fallback to file-backed`,
            );
            // fallthrough → 파일 기반 분기
          } else {
            // 아직 파일 리더 준비 전이면 빈 응답으로 대기(잘못된 1줄 클램프 방지)
            this.log.debug?.(
              `pagination(warm): out-of-range ${startIdx}-${endIdx} (N=${N}) with no reader → return empty`,
            );
            return [];
          }
        } else {
          // 부분 겹침(끝만 초과) 또는 정상 범위 → warm 슬라이스 제공
          const s = Math.max(1, Math.min(N, startIdx));
          const e = Math.max(1, Math.min(N, endIdx));
          const { physStart, physEndExcl } = mapAscToDescRange(N, s, e);
          const picked = buf.slice(physStart, physEndExcl).slice().reverse();
          for (let i = 0; i < picked.length; i++) {
            const eRow = picked[i] as any;
            eRow.idx = s + i;
          }
          this.log.debug?.(
            `pagination(warm): read ${startIdx}-${endIdx} -> ${picked.length} (phys ${physStart}-${physEndExcl})`,
          );
          return picked as LogEntry[];
        }
      }
    }

    // ── 파일 기반 모드 ───────────────────────────────────────────────────
    // 초기화 경합(첫 렌더 직후) 동안에는 예외를 던지지 말고 빈 결과를 반환해 UI가
    // placeholder를 유지하도록 한다. 곧 warm 또는 manifest가 준비되면 재요청됨.
    if (!this.reader) {
      if (!this.pendingWarned) {
        this.log.debug?.(
          'pagination: reader not ready yet (no warm buffer/manifest). returning empty slice.',
        );
        this.pendingWarned = true;
      }
      return [];
    }
    if (startIdx > endIdx) {
      this.log.warn(`pagination: invalid range ${startIdx}-${endIdx}`);
      return [];
    }
    // ⚠️ 파일 기반에서는 "실제 저장된 라인 수(mergedLines)"를 총량으로 사용
    const reportedTotal = this.reader.getTotalLines() ?? 0;
    let total = reportedTotal;
    try {
      const mf = (this.reader as any)?.getManifest?.();
      if (typeof mf?.mergedLines === 'number' && mf.mergedLines > 0) total = mf.mergedLines;
    } catch {}

    if (total <= 0) return [];
    const s = Math.max(1, Math.min(total, startIdx));
    const e = Math.max(1, Math.min(total, endIdx));
    if (e < s) return [];
    // 논리(오름차순) → 물리(내림차순 저장) 매핑
    const { physStart, physEndExcl } = mapAscToDescRange(total, s, e);
    if (physEndExcl <= physStart) return [];
    const rowsDesc = await this.reader.readLineRange(physStart, physEndExcl, { skipInvalid: true });
    const rowsAsc = rowsDesc.slice().reverse();
    if (rowsAsc.length === 0 && e - s + 1 > 0) {
      // 디버깅 지원: total(=mergedLines 우선)과 실제 커버리지 괴리 탐지
      try {
        const mf = (this.reader as any).getManifest?.();
        const merged = mf?.mergedLines;
        const hint = mf?.totalLines;
        const last = mf?.chunks?.[mf?.chunks?.length - 1];
        this.log.warn(
          `pagination: empty slice ${s}-${e} (need=${e - s + 1}) phys=${physStart}-${physEndExcl} total(effective)=${total} merged=${merged} hint(totalLines)=${hint} lastChunk=${last?.file || 'n/a'}@${last ? last.start + '+' + last.lines : 'n/a'}`,
        );
      } catch {}
    }
    for (let i = 0; i < rowsAsc.length; i++) {
      const eRow = rowsAsc[i] as any;
      eRow.idx = s + i; // 논리 오름차순 인덱스
    }
    // quiet
    return rowsAsc;
  }

  /** 필터 활성 시, "필터 결과 인덱스(오름차순)" 기준으로 [startIdx,endIdx] 구간을 반환 */
  async readRangeFiltered(startIdx: number, endIdx: number): Promise<LogEntry[]> {
    if (startIdx > endIdx) return [];
    const want = Math.max(0, endIdx - startIdx + 1);
    const out: LogEntry[] = [];
    const matches = (e: LogEntry) => this.matchesFilter(e);

    // 1) 워밍업 버퍼
    if (this.warmActive) {
      // 물리는 최신→오래된이므로, 필터 후 뒤집어 오름차순으로 본다
      const asc = (this.warmBuffer ?? []).filter(matches).slice().reverse();
      const s0 = Math.max(0, startIdx - 1);
      const slice = asc.slice(s0, s0 + want);
      for (let i = 0; i < slice.length; i++) {
        const e = slice[i] as any;
        if (typeof e._fileIdx !== 'number' && typeof e.idx === 'number') e._fileIdx = e.idx;
        e.idx = startIdx + i; // 오름차순 필터 공간
      }
      return slice;
    }

    // 2) 파일 기반: 전체를 창(window) 단위로 순회하며 필요한 슬라이스만 수집
    if (!this.reader) {
      this.log.debug?.('pagination: reader not ready for filtered read; returning empty slice.');
      return [];
    }
    const total = this.getFileTotal() ?? 0;
    if (total <= 0) return [];

    // ⬇️ 논리 오름차순을 보장하기 위해 "물리 끝→앞"으로 창을 옮겨 읽고, 각 창을 reverse
    const WINDOW = 2000;
    let v = 0; // 필터 공간(오름차순)에서의 누적 카운트
    for (let tail = total; tail > 0 && out.length < want; tail -= WINDOW) {
      const from = Math.max(0, tail - WINDOW);
      const toEx = tail;
      const partDesc = await this.reader.readLineRange(from, toEx, { skipInvalid: true });
      const partAsc = partDesc.slice().reverse();
      for (const e of partAsc) {
        if (!matches(e)) continue;
        v++;
        if (v < startIdx) continue;
        out.push(e);
        if (out.length >= want) break;
      }
    }
    return this.reindexFiltered(out, startIdx);
  }

  private normalizeFilter(f: any) {
    const s = (v: any) => String(v ?? '').trim();
    const norm = {
      pid: s(f?.pid),
      src: s(f?.src),
      proc: s(f?.proc),
      msg: s(f?.msg),
    };
    // 전부 빈 문자열이면 null 취급(필터 미적용)
    if (!norm.pid && !norm.src && !norm.proc && !norm.msg) return null;
    return norm;
  }
  /** 필터 총계 캐시 무효화(이유 로깅 포함) */
  private invalidateFilterCache(reason?: string) {
    this.filteredTotalCache = undefined;
    // 버전/모드 포함 키는 다음 계산 시 재생성
    this.filteredCacheKey = undefined;
    this.log.debug?.(`pagination.filter.cache.invalidate reason=${reason ?? 'unknown'}`);
  }

  // ── 필터 매칭 유틸: "wlan host, deauth" → [["wlan","host"],["deauth"]] ─────────
  private parseGroups(q?: string): string[][] {
    const s = String(q ?? '').toLowerCase();
    if (!s.trim()) return [];
    return s
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean)
      .map((g) =>
        g
          .split(/\s+/g)
          .map((t) => t.trim())
          .filter(Boolean),
      );
  }
  /** 단일 문자열 대상: 그룹 중 하나라도(OR) 해당 문자열이 모든 토큰(AND)을 포함하면 true */
  private matchTextByGroups(haystack: string, q?: string): boolean {
    const groups = this.parseGroups(q);
    if (groups.length === 0) return true;
    const s = String(haystack || '').toLowerCase();
    return groups.some((andTokens) => andTokens.every((tok) => s.includes(tok)));
  }
  /** 여러 후보 문자열 대상(src용): 후보 중 하나라도 그룹을 만족하면 true */
  private matchAnyCandidateByGroups(candidates: string[], q?: string): boolean {
    const groups = this.parseGroups(q);
    if (groups.length === 0) return true;
    const cands = (candidates || []).map((v) => String(v || '').toLowerCase()).filter(Boolean);
    if (cands.length === 0) return false;
    return groups.some((andTokens) => cands.some((c) => andTokens.every((tok) => c.includes(tok))));
  }

  private matchesFilter(e: LogEntry): boolean {
    if (!this.filter) return true;
    const f = this.filter;
    const parsed = this.parseLine(String(e.text || ''));
    const msg = String(parsed.msg || '');
    const proc = String(parsed.proc || '');
    const pid = String(parsed.pid || '');
    // ⬇︎ 세그먼트 키 일관성: file → basename(path)만을 후보로 사용 (source 미사용)
    const file = String((e as any).file ?? '');
    const p = String((e as any).path ?? '');
    const srcCands = [file.toLowerCase()];
    const has = (s?: string) => !!(s && String(s).trim());
    if (has(f.msg) && !this.matchTextByGroups(msg, f.msg)) return false;
    if (has(f.proc) && !this.matchTextByGroups(proc, f.proc)) return false;
    if (has(f.pid) && !this.matchTextByGroups(pid, f.pid)) return false;
    if (has(f.src) && !this.matchAnyCandidateByGroups(srcCands, f.src)) return false;
    return true;
  }

  /** UI와 동일한 규칙으로 한 줄을 proc/pid/msg로 파싱 */
  private parseLine(line: string) {
    const timeMatch = line.match(/^\[([^\]]+)\]\s+(.*)$/);
    let rest = line;
    if (timeMatch) {
      rest = timeMatch[2];
    }
    const procMatch = rest.match(/^([^\s:]+)\[(\d+)\]:\s*(.*)$/);
    let proc = '',
      pid = '',
      msg = rest;
    if (procMatch) {
      proc = procMatch[1];
      pid = procMatch[2];
      msg = procMatch[3] ?? '';
    }
    return { proc, pid, msg };
  }

  /** 필터 결과에 대해 가상 인덱스를 연속적으로 매겨 UI와 공간을 일치시킴 */
  private reindexFiltered(rows: LogEntry[], startIdx: number): LogEntry[] {
    for (let i = 0; i < rows.length; i++) {
      const e = rows[i] as any;
      if (typeof e._fileIdx !== 'number' && typeof e.idx === 'number') e._fileIdx = e.idx;
      e.idx = startIdx + i;
    }
    return rows;
  }
  /** 옛 호출자를 위한 호환 래퍼. 현재 필터 해제 */
  clearFilter() {
    this.setFilter(null);
  }

  // ────────────────────────────────────────────────────────────────────
  // 전체 검색(필터 적용 공간 기준) — 단일 패스로 선형 스캔 (warm/file 공용)
  // - 기존 HostWebviewBridge.search.query의 O(N^2) 접근을 대체
  // - 반환 idx는 "필터 결과 인덱스(오름차순, 1-based)" 공간 기준
  // - 옵션: regex / range / top (필요 시 확장)
  // ────────────────────────────────────────────────────────────────────
  async searchAll(
    q: string,
    opts?: { regex?: boolean; range?: [number, number]; top?: number },
  ): Promise<{ idx: number; text: string }[]> {
    const hits: { idx: number; text: string }[] = [];
    const regex = opts?.regex && q ? new RegExp(q, 'i') : null;
    const ql = (q || '').toLowerCase();
    const inRange = (k: number) =>
      !opts?.range || (k >= Math.max(1, opts.range[0]) && k <= Math.max(1, opts.range[1]));
    const wantMore = () => !opts?.top || hits.length < opts.top!;

    const test = (txt: string) => {
      if (!q) return true;
      return regex ? regex.test(txt) : txt.toLowerCase().includes(ql);
    };

    // 1) 워밍업 메모리 버퍼
    if (this.warmActive) {
      // 오름차순 스캔을 위해 뒤집어서 탐색
      const asc = (this.warmBuffer ?? [])
        .filter((e) => this.matchesFilter(e))
        .slice()
        .reverse();
      for (let i = 0; i < asc.length; i++) {
        const e = asc[i];
        const idx = i + 1;
        if (!inRange(idx)) continue;
        if (test(String(e.text || ''))) {
          hits.push({ idx, text: String(e.text || '') });
          if (!wantMore()) break;
        }
      }
      return hits;
    }

    // 2) 파일 기반 모드 — 한 번의 선형 스캔
    if (!this.reader) return hits;
    const total = this.getFileTotal() ?? 0;
    if (total <= 0) return hits;
    const WINDOW = 4000;
    let v = 0;
    for (let tail = total; tail > 0 && wantMore(); tail -= WINDOW) {
      const from = Math.max(0, tail - WINDOW);
      const toEx = tail;
      const partDesc = await this.reader.readLineRange(from, toEx, { skipInvalid: true });
      const partAsc = partDesc.slice().reverse();
      for (const e of partAsc) {
        if (!this.matchesFilter(e)) continue;
        v++;
        if (!inRange(v)) continue;
        const txt = String(e.text || '');
        if (test(txt)) {
          hits.push({ idx: v, text: txt });
          if (!wantMore()) break;
        }
      }
    }
    return hits;
  }
}

export const paginationService = new PaginationService();

// ────────────────────────────────────────────────────────────────────
// 중앙 매핑 유틸: 논리 오름차순 [s..e] → 물리 내림차순 [physStart, physEndExcl)
// (저장은 항상 ts 내림차순, 표시는 오름차순)
function mapAscToDescRange(total: number, s: number, e: number) {
  const physStart = Math.max(0, total - e);
  const physEndExcl = Math.min(total, total - s + 1);
  return { physStart, physEndExcl };
}
