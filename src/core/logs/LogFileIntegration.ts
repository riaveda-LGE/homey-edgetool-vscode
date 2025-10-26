// === src/core/logs/LogFileIntegration.ts ===
import type { LogEntry } from '@ipc/messages';
import * as fs from 'fs';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';

import { DEFAULT_BATCH_SIZE, MERGED_DIR_NAME } from '../../shared/const.js';
import { ErrorCategory, XError } from '../../shared/errors.js';
import { getLogger } from '../logging/extension-logger.js';
import { measureBlock } from '../logging/perf.js';
import {
  compileParserConfig,
  isParsedHeaderAllMissing,
  lineToEntryWithParser,
  shouldUseParserForFile,
} from './ParserEngine.js';
import { extractHeaderTimeToken, isYearlessTimeToken, parseTs } from './time/TimeParser.js';
import { MonotonicCorrector } from './time/TimezoneHeuristics.js';

const log = getLogger('LogFileIntegration');
// 파일 첫 문자 위치의 BOM 제거
const BOM_RE = /^\uFEFF/;
function stripBomStart(s: string): string {
  return s.replace(BOM_RE, '');
}

// ────────────────────────────────────────────────────────────────────────────
// DESC 병합 검증 헬퍼(노이즈 억제형): 역전(inversion) 집계와 범위만 로그
// ────────────────────────────────────────────────────────────────────────────
function countDescInversions(arr: { ts: number }[]): number {
  let inv = 0;
  for (let i = 1; i < arr.length; i++) {
    // 내림차순에서 앞 원소(ts[i-1])보다 뒤(ts[i])가 크면 역전
    if (arr[i].ts > arr[i - 1].ts) inv++;
  }
  return inv;
}
function tsRange(arr: { ts: number }[]): { max?: number; min?: number } {
  if (!arr.length) return {};
  let mx = arr[0].ts,
    mn = arr[0].ts;
  for (let i = 1; i < arr.length; i++) {
    const t = arr[i].ts;
    if (t > mx) mx = t;
    if (t < mn) mn = t;
  }
  return { max: mx, min: mn };
}
const toIso = (t?: number) => (typeof t === 'number' ? new Date(t).toISOString() : 'n/a');

// ────────────────────────────────────────────────────────────────────────────
// 연도 없는 포맷(syslog류) → 논리 연도 롤오버 연결기
// - 최신→오래된 스캔 중, ts가 "연도 없는 포맷"으로 파싱된 라인들에 한해
//   연(-1) 단위로 이동시키며 단조비증가(desc)를 보장한다.
// - 실제 연도 추정/주입 없음. 오직 순서 보존 목적.
// - [방법 A] 같은 초 또는 소규모 지터(≤ JITTER_TOLERANCE_MS)는 "연도 이동 금지"하고
//   해당 라인만 1ms 로컬 클램프하여 단조를 유지한다(출력 텍스트는 그대로).
// ────────────────────────────────────────────────────────────────────────────
class YearlessStitcher {
  private shiftYears = 0;
  private last?: number;
  // 같은 초/수백 ms 뒤섞임 허용(연도 롤오버로 오판 금지)
  private readonly JITTER_TOLERANCE_MS = 1500; // 1~2s 권장
  // 주어진 ts를 years 만큼 ±이동(UTC 기준, 월/일/윤년 보존)
  private shiftByYears(ts: number, years: number): number {
    if (!years) return ts;
    const d = new Date(ts);
    return Date.UTC(
      d.getUTCFullYear() + years,
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    );
  }
  apply(ts: number, isYearless: boolean): number {
    if (!isYearless) {
      // ⚠️ 유효하지 않은 ts(≤0, NaN)는 기준선에 반영하지 않음
      if (!(ts > 0) || !Number.isFinite(ts)) return ts;
      this.last = this.last === undefined ? ts : Math.min(this.last, ts);
      return ts;
    }
    let corrected = this.shiftByYears(ts, this.shiftYears);
    if (this.last === undefined) {
      this.last = corrected;
      return corrected;
    }
    // 단조 위반이면 연(-1) 적용 전에 "미세 역전" 예외를 먼저 검사
    if (corrected > this.last) {
      const delta = corrected - this.last;
      const sameSecond = Math.floor(corrected / 1000) === Math.floor(this.last / 1000);
      // ⬇️ 같은 초 또는 허용 지터 이내면: 연도 이동 금지, 라인만 1ms 내림
      if (sameSecond || delta <= this.JITTER_TOLERANCE_MS) {
        corrected = this.last - 1; // 로컬 1ms 클램프(표시 문자열은 원본 유지)
      } else {
        // 진짜 큰 역전(연말↔연초 등)로 판단 → 연(-1)씩 이동
        while (corrected > this.last) {
          this.shiftYears -= 1;
          corrected = this.shiftByYears(ts, this.shiftYears);
        }
      }
    }
    this.last = corrected;
    return corrected;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 공개 API
 * ────────────────────────────────────────────────────────────────────────── */

// Manager 선행 웜업 호출을 위해 필요한 필드만 분리(+ whitelist 지원)
export type WarmupOptions = Pick<
  MergeOptions,
  'dir' | 'signal' | 'warmupPerTypeLimit' | 'warmupTarget' | 'whitelistGlobs' | 'parser'
>;

export type MergeOptions = {
  dir: string;
  /** false(기본) = 최신→오래된 (타입별 JSONL → k-way)
   *   true        = 오래된→최신 (파일 단위가 아니라 **전역 타임스탬프 기준** k-way 병합, 타입 무관)
   */
  reverse?: boolean;
  signal?: AbortSignal;
  onBatch: (logs: LogEntry[]) => void;
  onWarmupBatch?: (logs: LogEntry[]) => void;
  batchSize?: number;
  mergedDirPath?: string; // 중간 산출물(JSONL) 저장 위치
  rawDirPath?: string; // (옵션) 보정 전 RAW 저장 위치
  /** warmup 선행패스 사용 여부 (기본: false, 상위 FeatureFlags로 채워짐) */
  warmup?: boolean;
  /** 병합 단계 알림(예: "Warmup 병합 시작", "로그병합 완료") */
  onStage?: (text: string, kind?: 'start' | 'done' | 'info') => void;
  onProgress?: (args: { done?: number; total?: number; active?: boolean }) => void;
  /** warmup 모드일 때 타입별 최대 선행 읽기 라인수 (기본: 500 등) */
  warmupPerTypeLimit?: number;
  /** warmup 모드일 때 최초 즉시 방출 목표치 (기본: 500) */
  warmupTarget?: number;
  /** 커스텀 파서 설정에서 온 files 화이트리스트(glob). 지정되면 여기에 매칭되는 파일만 수집 */
  whitelistGlobs?: string[];
  parser?: import('./ParserEngine.js').ParserConfig;
  /**
   * 파서 적용 시에도 테스트/골든 비교를 위해 원래 한 줄 포맷(`[time] proc[pid]: message`)을 유지.
   * - parser가 message-only로 바꾸더라도 parsed 필드(time/proc/pid/message)로 헤더를 복원해 `entry.text`를 채움
   * - 복원된 **헤더 기반**으로 parseTs 재적용(메시지 내부 ISO 타임스탬프 무시, 정렬 일관성 유지)
   */
  preserveFullText?: boolean;
};

/**
 * 디렉터리를 읽어 **최신순**으로 병합해 batch 콜백으로 흘려보낸다.
 * 새로운 방식: 타입별 메모리 로딩 → 최신→오래된(그대로) → 타임존 보정(국소 소급 보정 지원) →
 *             merged(JSONL, 최신순) 저장 → JSONL을 순방향으로 100줄씩 읽어 k-way 병합
 */
export async function mergeDirectory(opts: MergeOptions) {
  return measureBlock('logs.mergeDirectory', async function () {
    const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
    // 파서 컴파일

    // (참고) 전체 예상 총량 — 진행률 표시에 사용
    let totalEstimated: number | undefined = undefined;

    const compiledParser = opts.parser ? compileParserConfig(opts.parser) : undefined;
    // 화이트리스트(files 토큰) → "베이스네임" 매칭 정규식 셋으로 변환
    const allowPathRegexes = opts.whitelistGlobs?.length
      ? compileWhitelistPathRegexes(opts.whitelistGlobs)
      : undefined;

    // ─────────────────────────────────────────────────────────────────────────
    // 0) (호환) 워밍업 선행패스
    //    Manager-선행 웜업 경로에서는 mergeDirectory를 warmup:false로 호출하므로 여기 미실행
    if (
      opts.warmup &&
      (typeof opts.onWarmupBatch === 'function' || typeof opts.onBatch === 'function')
    ) {
      opts.onStage?.('Warmup 병합 시작', 'start');
      try {
        const warmLogs = await warmupTailPrepass({
          dir: opts.dir,
          signal: opts.signal,
          warmupPerTypeLimit: opts.warmupPerTypeLimit,
          warmupTarget: opts.warmupTarget,
        });
        if (warmLogs.length) {
          if (opts.onWarmupBatch) opts.onWarmupBatch(warmLogs);
          else opts.onBatch(warmLogs);
          opts.onStage?.('초기 배치 전달', 'info');
          opts.onProgress?.({ done: warmLogs?.length ?? 0, active: true });
          log.info(`warmup: delivered initial batch (n=${warmLogs.length})`);
        } else {
          log.debug?.('warmup: skipped or not enough lines');
        }
        opts.onStage?.('Warmup 병합 완료', 'done');
      } catch (e: any) {
        log.warn(`warmup: failed (${e?.message ?? e}) — fallback to full merge`);
      }
    }

    // ── 2) 기존 k-way/표준 패스 그대로 ───────────────────────────────────
    // 입력 로그(.log/.log.N/.txt) 수집 (루트만/비재귀)
    const files = await listInputLogFiles(opts.dir, allowPathRegexes);
    // start: quietened
    try {
      // 진행률 총량 추정(라인 수 총합). 큰 폴더에서도 빠르게 동작하도록 구현되어 있음.
      const estimated = await countTotalLinesInDir(opts.dir, allowPathRegexes);
      totalEstimated = Math.max(0, Number(estimated?.total ?? 0));
      if (totalEstimated === 0) totalEstimated = undefined;
      if (totalEstimated !== undefined) {
        opts.onProgress?.({ total: totalEstimated, active: true });
      }
    } catch {
      // 총량 추정 실패는 무시(진행률은 done-only로 동작)
    }
    if (!files.length) {
      log.warn('mergeDirectory: no log files to merge');
      return;
    }

    // 디버그/검증: reverse 모드 = 전역 타임스탬프 기준 k-way 병합(오래된→최신, 타입 무관)
    if (opts.reverse) {
      // 1) 파일 목록을 "타입 키 사전순 → 각 타입 내 회전번호 asc(.2→.1→.log)"로 평탄화해 fileRank 안정화
      const grouped = groupByType(files);
      const typeKeys = Array.from(grouped.keys()).sort();
      const all: string[] = [];
      for (const k of typeKeys) {
        const arr = (grouped.get(k) ?? []).slice().sort(compareLogOrderAsc);
        all.push(...arr);
      }
      // quiet

      // 2) 각 파일에 대한 forward 커서 생성(+ parser 프리플라이트)
      const cursors: FileForwardCursor[] = [];
      for (let i = 0; i < all.length; i++) {
        const full = path.join(opts.dir, all[i]);
        const cur = await FileForwardCursor.create(full, i, compiledParser);
        cursors.push(cur);
      }

      // 3) ts 오름차순(min-heap 동작) 병합
      type RevHeapItem = { ts: number; entry: LogEntry; cursor: FileForwardCursor; seq: number };
      const heap = new MaxHeap<RevHeapItem>((a, b) => {
        // ⬇︎ min-heap: 작은 ts가 우선
        if (a.ts !== b.ts) return b.ts - a.ts;
        // tie-breakers(안정성): fileRank asc → filename asc → revIdx asc → seq asc
        const aRank = (a.entry as any)._fRank ?? 9999;
        const bRank = (b.entry as any)._fRank ?? 9999;
        if (aRank !== bRank) return bRank - aRank; // aRank < bRank 면 a 우선(양수)
        const aFile = a.entry.file ?? '';
        const bFile = b.entry.file ?? '';
        if (aFile !== bFile) return bFile.localeCompare(aFile); // filename asc (a<b → 양수)
        const aRev = (a.entry as any)._rev ?? 9999;
        const bRev = (b.entry as any)._rev ?? 9999;
        if (aRev !== bRev) return bRev - aRev;
        return b.seq - a.seq;
      });

      // 초기 주입: 각 파일에서 1줄
      for (const cur of cursors) {
        const first = await cur.next();
        if (first) heap.push({ ...first, cursor: cur, seq: 0 });
      }

      const out: LogEntry[] = [];
      let emitted = 0;
      while (!heap.isEmpty()) {
        if (opts.signal?.aborted) {
          log.warn('mergeDirectory: aborted(reverse)');
          break;
        }
        const top = heap.pop()!;
        out.push(top.entry);
        if (out.length >= batchSize) {
          emitted += out.length;
          opts.onBatch(out.splice(0, out.length));
        }
        const next = await top.cursor.next();
        if (next) heap.push({ ...next, cursor: top.cursor, seq: top.seq + 1 });
      }
      if (!opts.signal?.aborted && out.length) {
        emitted += out.length;
        opts.onBatch(out);
      }
      // 자원 정리
      for (const c of cursors) await c.close();
      // quiet
      return;
    }

    // 중간 산출물 디렉터리
    const mergedDir = opts.mergedDirPath || path.join(opts.dir, MERGED_DIR_NAME);
    if (fs.existsSync(mergedDir)) fs.rmSync(mergedDir, { recursive: true, force: true });
    await fs.promises.mkdir(mergedDir, { recursive: true });

    const rawDir = opts.rawDirPath;
    if (rawDir) {
      if (fs.existsSync(rawDir)) fs.rmSync(rawDir, { recursive: true, force: true });
      await fs.promises.mkdir(rawDir, { recursive: true });
    }
    // quiet

    // 1) 타입 그룹화(.log 전용)
    const grouped = groupByType(files);
    // quiet

    // 2) 타입별 메모리 로딩(최신→오래된), 타임존 보정(국소), merged(JSONL) 저장(최신순)
    for (const [typeKey, fileList] of grouped) {
      if (opts.signal?.aborted) break;

      // quiet
      const logs: LogEntry[] = [];
      // ── 진행 텍스트(타입별) 준비 ───────────────────────────────────────
      const STAGE_UPDATE_MIN_MS = 600; // 전송 최소 간격(ms) — UI 스팸 방지
      let lastStageAt = 0;
      const updateStage = (force = false) => {
        const now = Date.now();
        if (!force && now - lastStageAt < STAGE_UPDATE_MIN_MS) return;
        lastStageAt = now;
        opts.onStage?.(`${typeKey} 로그를 정렬중`, 'info');
      };
      // 시작 시 표시
      opts.onStage?.(`${typeKey} 로그를 정렬중`, 'info');
      const fileSummaries: Array<{
        file: string;
        lines: number;
        parsedTime: number;
        noParsedTime: number;
        headerOk: number;
        headerFallbackFullOk: number;
        headerFailBoth: number;
        tsZero: number;
        parserOn: boolean;
      }> = [];

      // 최신 파일부터( *.log → *.log.1 → *.log.2 … )
      const orderedFiles = fileList.sort(compareLogOrderDesc);

      // 모든 파일을 ReverseLineReader로 읽음 → 각 파일 끝→시작(최신→오래된)으로 라인 푸시
      for (let fileIdx = 0; fileIdx < orderedFiles.length; fileIdx++) {
        const fileName = orderedFiles[fileIdx];
        const fullPath = path.join(opts.dir, fileName);
        // ── 커스텀 파서 프리플라이트(파일당 1회) ──
        let useParserForThisFile = false;
        if (compiledParser) {
          try {
            const rel = fileName.replace(/\\/g, '/'); // opts.dir 기준 상대경로(파일명 포함)
            useParserForThisFile = await shouldUseParserForFile(fullPath, rel, compiledParser);
          } catch {}
        }
        // quiet
        // 파일별 집계용 카운터
        const sum = {
          file: fileName,
          lines: 0,
          parsedTime: 0,
          noParsedTime: 0,
          headerOk: 0,
          headerFallbackFullOk: 0,
          headerFailBoth: 0,
          tsZero: 0,
          parserOn: useParserForThisFile,
        };

        const rr = await ReverseLineReader.open(fullPath);
        let line: string | null;
        let revIdx = 0;
        let prevTs: number | undefined = undefined;
        while ((line = await rr.nextLine()) !== null) {
          // fullPath를 넘겨 path/file 일관성 유지
          const entry = await lineToEntryWithParser(
            fullPath,
            line,
            useParserForThisFile ? compiledParser : undefined,
            { fileRank: fileIdx, revIdx: revIdx++, fallbackTs: prevTs },
          );

          // 파서 적용 파일: time/process/pid 셋 모두 없으면 무효 라인으로 폐기
          if (useParserForThisFile && isParsedHeaderAllMissing((entry as any)?.parsed)) {
            // 다음 라인으로 계속 (prevTs는 갱신하지 않음)
            continue;
          }

          // 폴백 ts는 '유지된' 이전 값으로 누적
          if (typeof entry.ts === 'number' && Number.isFinite(entry.ts) && entry.ts > 0) {
            prevTs = entry.ts;
          }
          // ── ts 출처·품질 집계 ─────────────────────────────────────────
          // 여기서부터는 유효 라인만 집계
          sum.lines++;
          // ⬇︎ 진행 텍스트 갱신(600ms 스로틀)
          updateStage();
          const p = (entry as any)?.parsed as
            | {
                time?: string | null;
                process?: string | null;
                pid?: string | number | null;
                message?: string | null;
              }
            | undefined;
          if (p?.time) {
            sum.parsedTime++;
            // 헤더/풀라인 재해석으로 출처 구분(로직 변경 없음, 집계만)
            const tHeader = parseTs(`[${String(p.time).trim()}]`);
            // 복원 라인을 로컬에서 생성(restoreFullTextIfNeeded과 동일 포맷)
            const pidRaw = p.pid == null ? '' : String(p.pid).trim();
            const pidBlock = pidRaw ? `[${pidRaw}]` : '';
            const full = `[${String(p.time).trim()}] ${String(p.process ?? '').trim()}${pidBlock}: ${String(p.message ?? entry.text ?? '')}`;
            const tFull = parseTs(full);
            if (typeof tHeader === 'number') sum.headerOk++;
            else if (typeof tFull === 'number') sum.headerFallbackFullOk++;
            else sum.headerFailBoth++;
          } else {
            sum.noParsedTime++;
          }
          if (!(typeof entry.ts === 'number' && Number.isFinite(entry.ts) && entry.ts > 0))
            sum.tsZero++;
          // 테스트/골든 일관성: 파서가 message-only로 바꿨다면 헤더 복원(+ ts 재계산)
          restoreFullTextIfNeeded(entry, !!opts.preserveFullText);
          logs.push(entry); // 전체 logs가 최신→오래된 순
        }
        await rr.close();
        fileSummaries.push(sum);
      }
      // quiet
      // 파일별 요약 출력(스팸 방지를 위해 info 1줄/파일)
      for (const s of fileSummaries) {
        log.info(
          `[probe:file-summary] type=${typeKey} file=${s.file} parser=${s.parserOn} lines=${s.lines} ` +
            `parsed.time=${s.parsedTime}/${s.lines} no.parsed=${s.noParsedTime} tsZero=${s.tsZero} ` +
            `hdrOK=${s.headerOk} hdr→full=${s.headerFallbackFullOk} hdrFail=${s.headerFailBoth}`,
        );
      }

      // ── 병합 DESC 검증(타임존 보정 전) 요약 ──
      if (logs.length) {
        const r0 = tsRange(logs);
        const inv0 = countDescInversions(logs);
        log.info(
          `[probe:merge-desc] type=${typeKey} beforeTZ len=${logs.length}` +
            ` range=[${toIso(r0.max)}..${toIso(r0.min)}] inversions=${inv0}`,
        );
      }

      // (옵션) RAW 저장 — 최신→오래된 그대로
      if (rawDir && logs.length) {
        const rawFile = path.join(rawDir, `${typeKey}.raw.jsonl`);
        for (const logEntry of logs) {
          await fs.promises.appendFile(rawFile, JSON.stringify(logEntry) + '\n');
        }
      }

      // 연도 없는 포맷(syslog류) 롤오버 연결 (단조비증가 보장)
      const yearlessStitcher = new YearlessStitcher();
      for (const log of logs) {
        const timeToken = extractHeaderTimeToken(log.text);
        const isYearless = timeToken ? isYearlessTimeToken(timeToken) : false;
        log.ts = yearlessStitcher.apply(log.ts, isYearless);
      }

      // 단조 보정 (MonotonicCorrector 사용)
      // ✅ 보정기는 "최신→오래된" 순으로 feed되는 것을 전제한다.
      // logs[]는 이미 최신→오래된 물리 순서이므로 0..N-1로 전진하며 처리한다.
      const tzc = new MonotonicCorrector(typeKey, 1); // 1ms 단위 클램프
      for (let asc = 0; asc < logs.length; asc++) {
        const corrected = tzc.adjust(logs[asc].ts);
        logs[asc].ts = corrected;
      }
      // 요약 출력
      tzc.summary();

      // ── 병합 DESC 검증(타임존 보정 후, 소트 전) 요약 ──
      if (logs.length) {
        const r1 = tsRange(logs);
        const inv1 = countDescInversions(logs);
        // quiet
      }

      // ⬇️ JSONL 저장은 "최신→오래된(내림차순)"으로 저장
      logs.sort((a, b) => b.ts - a.ts);

      // ── 최종 정렬 후 역전 검증 ──
      if (logs.length) {
        const r2 = tsRange(logs);
        const inv2 = countDescInversions(logs);
        if (inv2 !== 0) {
          log.error(
            `[merge-desc] order violation after sort: inversions=${inv2} range=[${toIso(r2.max)}..${toIso(r2.min)}]`,
          );
        }
      }
      const mergedFile = path.join(mergedDir, `${typeKey}.jsonl`);
      for (const logEntry of logs) {
        await fs.promises.appendFile(mergedFile, JSON.stringify(logEntry) + '\n');
      }
      // quiet
      // 타입별 최종 진행치로 한 번 더 고정
      updateStage(true);
      opts.onStage?.(`${typeKey} 타입 정렬 완료`, 'done');
    }

    // 3) 타입별 정렬이 모두 끝나면, 이제 JSONL → k-way 단일 병합을 시작
    opts.onStage?.('파일 병합을 시작', 'start');

    // 3) merged(JSONL)에서 타입별로 **순방향** 100줄씩 읽어 k-way 병합(최신→오래된)
    const mergedFiles = await listMergedJsonlFiles(mergedDir); // ← .jsonl 전용
    if (!mergedFiles.length) {
      log.warn(`T1: no merged jsonl files in ${mergedDir}`);
    }

    // 파일명에서 타입키 추출( clip.jsonl → clip )
    const cursors = new Map<string, MergedCursor>();
    for (const fileName of mergedFiles) {
      const typeKey = typeKeyFromJsonl(fileName);
      const fullPath = path.join(mergedDir, fileName);
      const cursor = await MergedCursor.create(fullPath, typeKey);
      cursors.set(typeKey, cursor);
    }
    // quiet

    // k-way max-heap: ts 큰 것(최신) 우선
    opts.onStage?.('로그병합 시작', 'start');
    const heap = new MaxHeap<HeapItem>((a, b) => {
      // ts desc
      if (a.ts !== b.ts) return a.ts - b.ts;
      // fileRank asc (작은 숫자 우선)
      const aRank = (a.entry as any)._fRank ?? 9999;
      const bRank = (b.entry as any)._fRank ?? 9999;
      if (aRank !== bRank) return bRank - aRank;
      // filename asc (사전순)
      const aFile = a.entry.file ?? '';
      const bFile = b.entry.file ?? '';
      if (aFile !== bFile) return bFile.localeCompare(aFile); // a<b → 양수(=a 우선)
      // revIdx asc (작은 숫자 우선)
      const aRev = (a.entry as any)._rev ?? 9999;
      const bRev = (b.entry as any)._rev ?? 9999;
      if (aRev !== bRev) return bRev - aRev;
      // fallback: typeKey asc(사전순), seq asc
      if (a.typeKey !== b.typeKey) return b.typeKey.localeCompare(a.typeKey); // a<b → 양수
      return b.seq - a.seq;
    });

    // 초기 주입: 각 타입에서 100줄(순방향=가장 최신부터)
    for (const [typeKey, cursor] of cursors) {
      const batch = await cursor.nextBatch(100);
      for (const item of batch) heap.push({ ...item, typeKey, seq: cursor.seq++ });
    }

    let emitted = 0;
    // k-way 전역 방출 순서 검증(desc): 위반만 샘플 3건
    let lastEmittedTs = Number.POSITIVE_INFINITY;
    let violations = 0;
    const violSamples: Array<{ ts: number; typeKey: string; file?: string; rev?: number }> = [];
    const outBatch: LogEntry[] = [];
    while (!heap.isEmpty()) {
      if (opts.signal?.aborted) {
        log.warn('mergeDirectory: aborted');
        break;
      }
      const top = heap.pop()!;
      outBatch.push(top.entry);

      // 전역 내림차순 방출 검증
      if (top.ts > lastEmittedTs) {
        violations++;
        if (violSamples.length < 3) {
          violSamples.push({
            ts: top.ts,
            typeKey: top.typeKey,
            file: (top.entry as any).file,
            rev: (top.entry as any)._rev,
          });
        }
      }
      lastEmittedTs = top.ts;

      if (outBatch.length >= batchSize) {
        emitted += outBatch.length;
        opts.onBatch(outBatch.splice(0, outBatch.length));
        // 진행률 갱신(100ms 스로틀은 브리지에서 처리)
        const d = emitted;
        opts.onProgress?.({ done: d, total: totalEstimated, active: true });
      }

      // 같은 타입에서 계속 최신쪽을 이어서 읽어 옴
      const cursor = cursors.get(top.typeKey)!;
      if (!cursor.isExhausted) {
        const next = await cursor.nextBatch(100);
        for (const item of next) heap.push({ ...item, typeKey: top.typeKey, seq: cursor.seq++ });
      }
    }

    // Abort 직후에는 부분 배치(outBatch)를 UI로 내보내지 않음
    if (!opts.signal?.aborted && outBatch.length) {
      emitted += outBatch.length;
      opts.onBatch(outBatch);
      const d = emitted;
      opts.onProgress?.({ done: d, total: totalEstimated, active: true });
    }

    // Abort 시 열려 있는 리더 자원 정리
    if (opts.signal?.aborted) {
      for (const [, cursor] of cursors) await cursor.close();
    }
    // quiet
    // 완료
    opts.onStage?.('로그병합 완료', 'done');

    if (emitted > 0) {
      opts.onProgress?.({ done: emitted, total: totalEstimated, active: false });
      const firstIso = toIso(lastEmittedTs); // 마지막 갱신값은 최종 최소(가장 오래된)
      if (violations) {
        log.warn(`[kway-desc] violations=${violations} tail_min=${firstIso}`);
      }
    }
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * 입력 로그 파일(.log/.log.N/.txt) 유틸 — **루트(비재귀)** 검색 + 경로 글롭 매칭
 *   - 요구사항: 로그는 루트에 있다고 가정, 하위경로는 고려하지 않음
 * ────────────────────────────────────────────────────────────────────────── */

export async function listInputLogFiles(
  dir: string,
  allowPathRegexes?: RegExp[],
): Promise<string[]> {
  try {
    const out: string[] = [];
    await walk(dir, '', out, allowPathRegexes);
    if (allowPathRegexes?.length && out.length === 0) {
      log.warn('listInputLogFiles: whitelist present but no files matched');
    }
    return out;
  } catch (e) {
    throw new XError(
      ErrorCategory.Path,
      `Failed to list log files in ${dir}: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

/** 루트 디렉터리 워커(비재귀): 상대경로 기준으로 필터링 */
async function walk(root: string, rel: string, out: string[], allowPathRegexes?: RegExp[]) {
  const base = rel ? path.join(root, rel) : root;
  let names: string[];
  try {
    names = await fs.promises.readdir(base);
  } catch (e) {
    return;
  }
  for (const name of names) {
    const relPath = rel ? path.join(rel, name) : name;
    const full = path.join(root, relPath);
    let st;
    try {
      st = await fs.promises.lstat(full);
    } catch (e) {
      continue;
    }
    // ⬇︎ 비재귀: 디렉터리는 탐색하지 않음
    if (st.isDirectory()) {
      continue;
    }
    if (!st.isFile()) {
      continue;
    }
    // 기본 허용: *.log / *.log.N / *.txt
    const bn = path.basename(relPath);
    const isLogLike = /\.log(\.\d+)?$/i.test(bn) || /\.txt$/i.test(bn);
    if (!allowPathRegexes?.length && !isLogLike) {
      continue;
    }
    // 화이트리스트가 있으면 "상대경로"로 매칭
    if (allowPathRegexes?.length && !pathMatchesWhitelist(relPath, allowPathRegexes)) {
      continue;
    }
    out.push(relPath);
  }
}

/** 병합 전 총 라인수 계산 (참고용) — 최신 파일부터 세되 결과는 단순 합 */
export async function countTotalLinesInDir(
  dir: string,
  allowPathRegexes?: RegExp[],
): Promise<{ total: number; files: { name: string; lines: number }[] }> {
  return measureBlock('logs.countTotalLinesInDir', async function () {
    const files = await listInputLogFiles(dir, allowPathRegexes);
    const ordered = files.sort(compareLogOrderDesc); // 최신부터
    const details: { name: string; lines: number }[] = [];
    let total = 0;

    for (const name of ordered) {
      const full = path.join(dir, name);
      const lines = await countLinesInFile(full);
      details.push({ name, lines });
      total += lines;
    }
    return { total, files: details };
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * 내부 유틸
 * ────────────────────────────────────────────────────────────────────────── */

function compareLogOrderDesc(a: string, b: string) {
  // 베이스(회전번호 없음=-1) > .1 > .2 … (숫자 작을수록 최신)
  return numberSuffix(path.basename(a)) - numberSuffix(path.basename(b));
}
function compareLogOrderAsc(a: string, b: string) {
  return -compareLogOrderDesc(a, b);
}
function numberSuffix(name: string) {
  // 파일명 끝의 ".숫자"를 회전 번호로 간주(없으면 -1)
  const bn = path.basename(name);
  const m = bn.match(/^(.*)\.(\d+)$/);
  return m ? parseInt(m[2], 10) : -1;
}
async function isRegularFile(p: string): Promise<boolean> {
  try {
    const st = await fs.promises.lstat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function countLinesInFile(filePath: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let count = 0;
    let sawAny = false;
    let endsWithLF = false;

    const rs = fs.createReadStream(filePath);
    rs.on('data', (chunk: string | Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sawAny = sawAny || buf.length > 0;
      endsWithLF = buf[buf.length - 1] === 0x0a; // '\n'
      for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) count++;
    });
    rs.on('end', () => {
      if (sawAny && !endsWithLF) count += 1;
      resolve(count);
    });
    rs.on('error', (e) => reject(e));
  });
}

/** 타입키 추출(확장자 무관): 'system.log.1' -> 'system.log' / 'homey-pro.2' -> 'homey-pro' / 'clip.log' -> 'clip.log' */
function typeKeyOf(name: string): string {
  const bn = path.basename(name);
  const m = bn.match(/^(.+?)(?:\.(\d+))?$/);
  return m ? m[1] : bn;
}

/** 파일 목록을 타입키별로 묶기(.log 전용) */
function groupByType(files: string[]): Map<string, string[]> {
  const mp = new Map<string, string[]>();
  for (const f of files) {
    const k = typeKeyOf(f);
    const v = mp.get(k);
    if (v) v.push(f);
    else mp.set(k, [f]);
  }
  return mp;
}

/* ──────────────────────────────────────────────────────────────────────────
 * 화이트리스트(파일명 토큰) → "베이스네임" 매칭 정규식
 *   - 경로/글롭 미지원. 루트 폴더에 있다고 가정.
 *   - 규칙:
 *     · "^"로 시작하면 정규식(그대로 사용, i 플래그)
 *     · 그 외는 리터럴 파일명으로 간주 → ^…$ 로 앵커링(i 플래그)
 * ────────────────────────────────────────────────────────────────────────── */
export function compileWhitelistPathRegexes(globs: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const g of globs ?? []) {
    const rx = nameTokenToRegex(g);
    if (rx) out.push(rx);
  }
  return out;
}

export function pathMatchesWhitelist(relPath: string, allow: RegExp[]): boolean {
  // 베이스네임만 매칭
  const bn = path.basename(relPath.replace(/\\/g, '/'));
  for (const rx of allow) if (rx.test(bn)) return true;
  return false;
}

function escapeRe(s: string) {
  // RFC 7613 호환: 일반적인 RegExp 이스케이프 안전 집합
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function nameTokenToRegex(token: string): RegExp | null {
  if (!token || typeof token !== 'string') return null;
  const t = token.trim();
  if (t.startsWith('^')) {
    try {
      return new RegExp(t, 'i');
    } catch {
      return null;
    }
  }
  return new RegExp(`^${escapeRe(t)}$`, 'i');
}

/* ──────────────────────────────────────────────────────────────────────────
 * 순방향(오래된→최신) 스트리밍 — reverse=true 시 사용
 * ────────────────────────────────────────────────────────────────────────── */
async function streamFileForward(
  filePath: string,
  emit: (batch: LogEntry[]) => void,
  batchSize: number,
  signal?: AbortSignal,
  compiledParser?: import('./ParserEngine.js').CompiledParser,
  fileRank?: number,
) {
  const fr = new ForwardLineReader(filePath);
  // 파일당 1회 parser gate
  let useParserForThisFile = false;
  if (compiledParser) {
    try {
      const bn = path.basename(filePath).replace(/\\/g, '/');
      useParserForThisFile = await shouldUseParserForFile(filePath, bn, compiledParser);
    } catch {}
  }
  const batch: LogEntry[] = [];
  let revIdx = 0;
  while (!signal?.aborted) {
    const lines = await fr.nextLines(batchSize);
    if (!lines.length) break;
    for (const line of lines) {
      if (!line) continue;
      const e = await lineToEntryWithParser(
        filePath,
        line,
        useParserForThisFile ? compiledParser : undefined,
        { fileRank, revIdx: revIdx++ },
      );
      // 파서 적용 파일: time/process/pid 셋 모두 없으면 무효 라인으로 폐기
      if (useParserForThisFile && isParsedHeaderAllMissing((e as any)?.parsed)) {
        continue;
      }
      restoreFullTextIfNeeded(e, /*preserve*/ true);
      batch.push(e);
      if (batch.length >= batchSize) emit(batch.splice(0, batch.length));
    }
  }
  if (!signal?.aborted && batch.length) emit(batch.splice(0, batch.length));
  await fr.close();
}

/* ──────────────────────────────────────────────────────────────────────────
 * 최신→오래된 역방향 라인 리더 (개별 *.log 파일 읽기용)
 * ────────────────────────────────────────────────────────────────────────── */

class ReverseLineReader {
  private fh: FileHandle | null = null;
  private fileSize = 0;
  private pos = 0;
  private buffer = '';
  private readonly chunkSize = 64 * 1024;
  private bomStripped = false;

  constructor(public readonly filePath: string) {}

  static async open(filePath: string) {
    const r = new ReverseLineReader(filePath);
    const st = await fs.promises.stat(filePath);
    r.fileSize = st.size;
    r.pos = st.size;
    r.fh = await fs.promises.open(filePath, 'r');
    return r;
  }

  async nextLine(): Promise<string | null> {
    if (this.fh === null) return null;
    while (true) {
      const nlIdx = this.buffer.lastIndexOf('\n');
      if (nlIdx >= 0) {
        const line = this.buffer.slice(nlIdx + 1);
        this.buffer = this.buffer.slice(0, nlIdx);
        if (line.length === 0) continue;
        return line.replace(/\r$/, '');
      }
      if (this.pos === 0) {
        if (!this.buffer) return null;
        const last = this.buffer;
        this.buffer = '';
        return last.replace(/\r$/, '');
      }
      const readSize = Math.min(this.chunkSize, this.pos);
      const start = this.pos - readSize;
      const buf = Buffer.alloc(readSize);
      await this.fh.read(buf, 0, readSize, start);
      let chunk = buf.toString('utf8');
      // 역방향 리더는 파일 끝부터 읽기 시작하므로,
      // 파일 시작을 포함하는 청크(start === 0)에서만 BOM을 제거한다.
      if (!this.bomStripped && start === 0) {
        chunk = stripBomStart(chunk);
        this.bomStripped = true;
      }
      this.buffer = chunk + this.buffer;
      this.pos = start;
    }
  }

  async close() {
    if (this.fh !== null) {
      try {
        await this.fh.close();
      } catch {}
      this.fh = null;
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 순방향 라인 리더(JSONL용) + merged 커서 + heap
 * ────────────────────────────────────────────────────────────────────────── */

// JSONL(.jsonl) 목록
async function listMergedJsonlFiles(dir: string): Promise<string[]> {
  try {
    const names = await fs.promises.readdir(dir);
    const results: string[] = [];
    for (const name of names) {
      const full = path.join(dir, name);
      if (!(await isRegularFile(full))) continue;
      if (!/\.jsonl$/i.test(name)) continue;
      results.push(name);
    }
    results.sort(); // 타입별 1개지만, 혹시 몰라 사전순
    return results;
  } catch (e) {
    throw new XError(
      ErrorCategory.Path,
      `Failed to list merged jsonl files in ${dir}: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

// clip.jsonl -> clip
function typeKeyFromJsonl(name: string): string {
  return name.replace(/\.jsonl$/i, '');
}

class ForwardLineReader {
  private rs: fs.ReadStream;
  private buffer = '';
  private queue: string[] = [];
  private ended = false;
  private errored: Error | null = null;
  private waiters: Array<() => void> = [];
  private bomStripped = false;

  constructor(public readonly filePath: string) {
    this.rs = fs.createReadStream(filePath, { encoding: 'utf8' });
    this.rs.on('data', (chunk) => {
      let data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (!this.bomStripped) {
        data = stripBomStart(data);
        this.bomStripped = true;
      }
      this.buffer += data;
      const parts = this.buffer.split(/\r?\n/);
      this.buffer = parts.pop() ?? '';
      if (parts.length) {
        this.queue.push(...parts.filter(Boolean));
        this.flushWaiters();
      }
    });
    this.rs.on('end', () => {
      if (this.buffer) this.queue.push(this.buffer);
      this.ended = true;
      this.flushWaiters();
    });
    this.rs.on('error', (e) => {
      this.errored = e instanceof Error ? e : new Error(String(e));
      this.flushWaiters();
    });
  }

  private flushWaiters() {
    while (this.waiters.length) this.waiters.shift()!();
  }

  private async waitForData() {
    if (this.queue.length || this.ended || this.errored) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  async nextLines(n: number): Promise<string[]> {
    const out: string[] = [];
    while (out.length < n) {
      if (this.queue.length) {
        out.push(this.queue.shift()!);
        continue;
      }
      if (this.errored) throw this.errored;
      if (this.ended) break;
      await this.waitForData();
    }
    return out;
  }

  async close() {
    try {
      this.rs.close();
    } catch {}
  }
}

/** 일반 텍스트 로그 파일용 forward 커서(라인→LogEntry) */
class FileForwardCursor {
  private reader: ForwardLineReader | null = null;
  private useParser = false;
  public isExhausted = false;
  private seq = 0;
  private prevTs?: number;

  private constructor(
    public readonly filePath: string,
    private readonly fileRank: number,
    private readonly compiledParser?: import('./ParserEngine.js').CompiledParser,
  ) {}

  static async create(
    filePath: string,
    fileRank: number,
    compiledParser?: import('./ParserEngine.js').CompiledParser,
  ): Promise<FileForwardCursor> {
    const c = new FileForwardCursor(filePath, fileRank, compiledParser);
    c.reader = new ForwardLineReader(filePath);
    if (compiledParser) {
      try {
        const bn = path.basename(filePath).replace(/\\/g, '/');
        c.useParser = await shouldUseParserForFile(filePath, bn, compiledParser);
      } catch {
        c.useParser = false;
      }
    }
    // quiet
    return c;
  }

  async next(): Promise<{ ts: number; entry: LogEntry } | null> {
    if (this.isExhausted || !this.reader) return null;
    while (true) {
      const lines = await this.reader.nextLines(1);
      if (!lines.length) {
        this.isExhausted = true;
        await this.reader.close();
        this.reader = null;
        return null;
      }
      const line = lines[0];
      const e = await lineToEntryWithParser(
        this.filePath,
        line,
        this.useParser ? this.compiledParser : undefined,
        { fileRank: this.fileRank, revIdx: this.seq++, fallbackTs: this.prevTs },
      );
      if (this.useParser && isParsedHeaderAllMissing((e as any)?.parsed)) {
        continue; // 무효 라인 건너뛰고 다음 라인 시도
      }
      restoreFullTextIfNeeded(e, /*preserve*/ true);
      if (typeof e.ts === 'number' && Number.isFinite(e.ts) && e.ts > 0) this.prevTs = e.ts;
      return { ts: e.ts, entry: e };
    }
  }

  async close() {
    try {
      await this.reader?.close();
    } catch {}
    this.isExhausted = true;
  }
}

/** JSONL에서 "앞에서부터" size줄 읽기 */
class MergedCursor {
  private reader: ForwardLineReader | null = null;
  public seq = 0;
  public isExhausted = false;
  // 배치 간 단조비증가(desc) 검증용
  private lastTsDesc?: number;

  private constructor(public typeKey: string) {}

  async close() {
    if (this.reader) {
      await this.reader.close();
      this.reader = null;
    }
    this.isExhausted = true;
  }

  static async create(filePath: string, typeKey: string): Promise<MergedCursor> {
    const c = new MergedCursor(typeKey);
    c.reader = new ForwardLineReader(filePath);
    return c;
  }

  async nextBatch(size: number): Promise<{ ts: number; entry: LogEntry }[]> {
    if (!this.reader || this.isExhausted) return [];
    const lines = await this.reader.nextLines(size);
    if (lines.length === 0) {
      this.isExhausted = true;
      await this.reader.close();
      this.reader = null;
      return [];
    }
    const batch: { ts: number; entry: LogEntry }[] = [];
    for (const line of lines) {
      try {
        const entry: LogEntry = JSON.parse(line);
        // ⬇︎ 구버전 JSONL 호환: file/path가 없으면 source에서 유도
        if (!(entry as any).file) {
          const cand = (entry as any).path || entry.source || '';
          (entry as any).file = path.basename(String(cand));
        }
        // source는 덮어쓰지 않음 — 파일명 소실 방지(표시/필터 모두 file/path 우선)
        batch.push({ ts: entry.ts, entry });
      } catch {
        // malformed 라인은 건너뜀
      }
    }
    // 배치 내부는 desc로 저장되어 있어야 함(단조비증가)
    if (batch.length) {
      let inv = 0;
      for (let i = 1; i < batch.length; i++) if (batch[i].ts > batch[i - 1].ts) inv++;
      if (inv > 0) {
        const a = new Date(batch[0].ts).toISOString();
        const z = new Date(batch[batch.length - 1].ts).toISOString();
        log.warn(`[cursor-desc] ${this.typeKey}: inversions=${inv} range=[${a}..${z}]`);
      }
      // 배치 경계(desc) 유지 확인: 다음 배치의 첫 ts ≤ 이전 배치의 마지막 ts
      const curFirst = batch[0].ts;
      if (this.lastTsDesc !== undefined && curFirst > this.lastTsDesc) {
        log.warn(
          `[cursor-desc] ${this.typeKey}: cross-batch order violation cur_first=${toIso(curFirst)} prev_last=${toIso(this.lastTsDesc)}`,
        );
      }
      // 현재 배치의 마지막(ts가 가장 작은 값)을 보관
      this.lastTsDesc = batch[batch.length - 1].ts;
    }
    return batch;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Test-only exports (do not use in production)
//  - 내부 커서/유틸을 단위/회귀 테스트에서만 직접 검증할 수 있도록 노출
// ────────────────────────────────────────────────────────────────────────────
export const __testOnly = { MergedCursor, listMergedJsonlFiles, typeKeyFromJsonl };

type HeapItem = { ts: number; entry: LogEntry; typeKey: string; seq: number };

/** 간단 max-heap 구현 */
class MaxHeap<T> {
  private arr: T[] = [];
  constructor(private cmp: (a: T, b: T) => number) {}
  size() {
    return this.arr.length;
  }
  isEmpty() {
    return this.arr.length === 0;
  }
  peek() {
    return this.arr[0];
  }
  push(v: T) {
    this.arr.push(v);
    this.up(this.arr.length - 1);
  }
  pop(): T | undefined {
    if (this.arr.length === 0) return undefined;
    const top = this.arr[0];
    const last = this.arr.pop()!;
    if (this.arr.length) {
      this.arr[0] = last;
      this.down(0);
    }
    return top;
  }
  private up(i: number) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(this.arr[p], this.arr[i]) >= 0) break;
      [this.arr[p], this.arr[i]] = [this.arr[i], this.arr[p]];
      i = p;
    }
  }
  private down(i: number) {
    const n = this.arr.length;
    while (true) {
      const l = i * 2 + 1,
        r = l + 1;
      let m = i;
      if (l < n && this.cmp(this.arr[l], this.arr[m]) > 0) m = l;
      if (r < n && this.cmp(this.arr[r], this.arr[m]) > 0) m = r;
      if (m === i) break;
      [this.arr[i], this.arr[m]] = [this.arr[m], this.arr[i]];
      i = m;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser 적용 시 헤더 복원 유틸
//  - parser가 message-only로 만든 경우에도 테스트/골든 비교를 위해 원 포맷을 재구성
//  - 복원된 전체 라인으로 parseTs 재계산(정렬 일관성)
function restoreFullTextIfNeeded(e: LogEntry, preserve: boolean) {
  if (!preserve) return;
  const p = (e as any)?.parsed as
    | {
        time?: string | null;
        process?: string | null;
        pid?: string | number | null;
        message?: string | null;
      }
    | undefined;
  if (!p) return;
  const time = (p.time ?? '').toString().trim();
  const proc = (p.process ?? '').toString().trim();
  if (!time || !proc) return;
  const pid =
    p.pid === undefined || p.pid === null || String(p.pid).trim() === ''
      ? ''
      : `[${String(p.pid).trim()}]`;
  const msg = (p.message ?? e.text ?? '').toString();
  const full = `[${time}] ${proc}${pid ? `${pid}` : ''}: ${msg}`;
  // 헤더 우선으로 ts를 계산하고, 실패 시에만 전체 라인 파싱을 사용
  const tHeader = parseTs(`[${time}]`);
  const tFull = parseTs(full);
  const t = typeof tHeader === 'number' ? tHeader : tFull;
  // 로깅: tHeader가 사용되었는지 tFull이 사용되었는지 기록
  // quiet diagnostics
  if (typeof t === 'number') e.ts = t;
  e.text = full;
}

// ─────────────────────────────────────────────────────────────────────────────
// 워밍업 선행패스 구현 (균등+재분배 / 타임존 보정 / 정확히 target개 방출)
// - 타입 수에 맞춰 균등 할당 후 남는 몫(remainder) 분배
// - 어떤 타입이 모자라면 잔여 할당을 다른 타입으로 "재분배"
// - 타입별 버퍼는 최신→오래된 순으로 수집 후 타임존 보정, 보정 후 최신순(ts desc) 정렬
// - 최종 k-way 병합으로 정확히 target개만 반환
// ⬇️ Manager에서 직접 호출할 수 있도록 export + LogEntry[] 반환
export async function warmupTailPrepass(opts: WarmupOptions): Promise<LogEntry[]> {
  return measureBlock('logs.warmupTailPrepass', async function () {
    const { dir, signal } = opts;
    log.debug?.(`warmupTailPrepass: start dir=${dir}`);
    const compiledParser = opts.parser ? compileParserConfig(opts.parser) : undefined;
    const target = Math.max(1, Number(opts.warmupTarget ?? 500));
    const perTypeCap = Number.isFinite(opts.warmupPerTypeLimit ?? NaN)
      ? Math.max(1, Number(opts.warmupPerTypeLimit))
      : Number.POSITIVE_INFINITY;
    const aborted = () => !!signal?.aborted;
    if (aborted()) return [];

    // 1) 입력 로그 파일 수집(화이트리스트 반영) → 타입별 그룹화(회전 파일 포함)
    const allowPathRegexes = opts.whitelistGlobs?.length
      ? compileWhitelistPathRegexes(opts.whitelistGlobs)
      : undefined;
    const names = await listInputLogFiles(dir, allowPathRegexes);
    if (!names.length) return [];
    const grouped = groupByType(names); // key: type, val: ['x.log', 'x.log.1', ...]
    const typeKeys = [...grouped.keys()];
    const T = typeKeys.length;
    if (!T) return [];

    // 2) 균등 + remainder 분배 (cap 고려)
    const base = Math.floor(target / T);
    let rem = target % T;
    const alloc = new Map<string, number>();
    for (let i = 0; i < T; i++) {
      const k = typeKeys[i];
      const want = base + (rem > 0 ? 1 : 0);
      if (rem > 0) rem--;
      alloc.set(k, Math.min(want, perTypeCap));
    }
    // quiet

    // 3) 타입별 tail walker 준비
    class TypeTailWalker {
      private idx = 0;
      private rr: ReverseLineReader | null = null;
      private exhausted = false;
      private useParserForCurrentFile = false;
      constructor(
        private baseDir: string,
        private files: string[],
        private typeKey: string,
      ) {}
      get isExhausted() {
        return this.exhausted;
      }
      private async ensureReader() {
        while (!this.rr && this.idx < this.files.length) {
          const fp = path.join(this.baseDir, this.files[this.idx]);
          try {
            this.rr = await ReverseLineReader.open(fp);
            // file-scoped parser gate (once per file)
            if (compiledParser) {
              try {
                const bn = path.basename(fp).replace(/\\/g, '/');
                this.useParserForCurrentFile = await shouldUseParserForFile(fp, bn, compiledParser);
              } catch {
                this.useParserForCurrentFile = false;
              }
            } else {
              this.useParserForCurrentFile = false;
            }
            // quiet
          } catch {
            // 파일 오픈 실패 시 다음 파일로
            this.idx++;
          }
        }
        if (!this.rr && this.idx >= this.files.length) this.exhausted = true;
      }
      async next(n: number): Promise<{ line: string; file: string; useParser: boolean }[]> {
        if (this.exhausted) return [];
        await this.ensureReader();
        const out: { line: string; file: string; useParser: boolean }[] = [];
        while (out.length < n && !this.exhausted) {
          if (!this.rr) {
            this.exhausted = true;
            break;
          }
          const line = await this.rr.nextLine();
          if (line === null) {
            // 현재 파일 끝 → 닫고 다음 파일
            try {
              await this.rr.close();
            } catch {}
            this.rr = null;
            this.idx++;
            // quiet
            await this.ensureReader();
            continue;
          }
          out.push({
            line,
            file: this.files[this.idx],
            useParser: this.useParserForCurrentFile,
          });
        }
        return out;
      }
    }

    // 타입별 워커/버퍼 초기화
    const walkers = new Map<string, TypeTailWalker>();
    const buffers = new Map<string, LogEntry[]>();
    const prevTsMap = new Map<string, number | undefined>(); // 타입별 prevTs 폴백
    for (const k of typeKeys) {
      const files = grouped.get(k)!.slice().sort(compareLogOrderDesc);
      walkers.set(k, new TypeTailWalker(dir, files, k));
      buffers.set(k, []);
      prevTsMap.set(k, undefined);
    }
    // quiet

    // 헬퍼: 라인 -> LogEntry (파일명을 source로)
    const toEntry = async (
      fileName: string,
      line: string,
      useParser: boolean,
      fallbackTs?: number,
    ): Promise<LogEntry> => {
      const full = path.join(dir, fileName);
      const e = await lineToEntryWithParser(full, line, useParser ? compiledParser : undefined, {
        fallbackTs,
      });
      // 테스트/골든/정렬 일관성: 헤더 복원 + 헤더 기반 ts 재계산
      restoreFullTextIfNeeded(e, /*preserve*/ true);
      return e;
    };

    // 4) 1차 수집: 균등 할당만큼 per-type 로딩
    const batchRead = async (typeKey: string, need: number) => {
      if (need <= 0) return 0;
      const w = walkers.get(typeKey)!;
      let got = 0; // ✅ 유효 엔트리(버퍼에 push된) 개수
      let prevTs = prevTsMap.get(typeKey);
      // 한 번에 너무 큰 I/O를 피하려고 소형 청크로 읽음
      const CHUNK = 64;
      while (got < need && !w.isExhausted && !aborted()) {
        const n = Math.min(CHUNK, need - got);
        const part = await w.next(n);
        if (!part.length) break;
        const buf = buffers.get(typeKey)!;
        let pushedThisRound = 0;
        for (const { line, file, useParser } of part) {
          const e = await toEntry(file, line, useParser, prevTs);
          if (useParser && isParsedHeaderAllMissing((e as any)?.parsed)) {
            continue; // 무효 라인 폐기
          }
          if (typeof e.ts === 'number' && Number.isFinite(e.ts)) prevTs = e.ts;
          buf.push(e);
          pushedThisRound++;
        }
        // ⚠️ 단순 읽은 라인 개수가 아니라 "유효하게 추가된" 라인 수로 집계
        got += pushedThisRound;
      }
      prevTsMap.set(typeKey, prevTs);
      return got;
    };

    let total = 0;
    for (const k of typeKeys) {
      const want = alloc.get(k)!;
      const gotK = await batchRead(k, want);
      total += gotK;
      // quiet
    }

    // 5) 재분배: target까지 부족하면 남은 타입에서 추가 로딩
    // quiet
    let deficit = Math.max(0, target - total);
    if (deficit > 0) {
      // 현재 각 타입이 cap에 도달했는지 계산
      const room = () =>
        typeKeys
          .filter((k) => !walkers.get(k)!.isExhausted) // ❗ exhausted 제외
          .map((k) => ({
            k,
            room: Math.max(
              0,
              (perTypeCap === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : perTypeCap) -
                buffers.get(k)!.length,
            ),
          }))
          .filter((x) => x.room > 0);
      let slots = room();
      // 라운드로빈으로 1~CHUNK씩 분배
      let i = 0;
      const CHUNK = 64;
      let lastProgressTotal = total;
      while (deficit > 0 && slots.length && !aborted()) {
        const { k, room: r } = slots[i % slots.length];
        const w = walkers.get(k)!;
        if (w.isExhausted) {
          i++;
          slots = room();
          continue;
        }
        const take = Math.min(CHUNK, r, deficit);
        if (take > 0) {
          const before = buffers.get(k)!.length;
          const got = await batchRead(k, take);
          const after = buffers.get(k)!.length;
          deficit -= got;
          total += got;
          // quiet
        }
        // 정체(진전 없음) 탐지 → 모두 소진이면 탈출
        if (total === lastProgressTotal) {
          const anyActive = typeKeys.some((tk) => !walkers.get(tk)!.isExhausted);
          if (!anyActive) {
            log.warn(`warmup: all types exhausted; total=${total}, target=${target}`);
            break;
          }
        } else {
          lastProgressTotal = total;
        }
        i++;
        slots = room();
      }
      // quiet
    }

    if (total === 0) return [];

    // quiet
    // 6) 타입별 타임존 보정 + 최신순 정렬 + source 통일
    for (const k of typeKeys) {
      const arr = buffers.get(k)!;
      if (!arr.length) continue;
      // before TZ: 역전/범위 요약 (warm 전용 프로브)
      const r0 = tsRange(arr);
      const inv0 = countDescInversions(arr);
      log.info(
        `[probe:warm-desc] type=${k} beforeTZ len=${arr.length} range=[${toIso(r0.max)}..${toIso(r0.min)}] inversions=${inv0}`,
      );
      // 연도 없는 포맷(syslog류) 롤오버 연결 (단조비증가 보장)
      const yearlessStitcher = new YearlessStitcher();
      for (const log of arr) {
        const timeToken = extractHeaderTimeToken(log.text);
        const isYearless = timeToken ? isYearlessTimeToken(timeToken) : false;
        log.ts = yearlessStitcher.apply(log.ts, isYearless);
      }
      const tzc = new MonotonicCorrector(k, 1); // 1ms 단위 클램프
      // warm 버퍼도 물리 배열은 최신→오래된. ✅ 앞→뒤(0..N-1)로 feed
      for (let asc = 0; asc < arr.length; asc++) {
        const corrected = tzc.adjust(arr[asc].ts);
        arr[asc].ts = corrected;
      }
      // quiet summary
      // after TZ(before sort)
      const r1 = tsRange(arr);
      const inv1 = countDescInversions(arr);
      // quiet
      arr.sort((a, b) => b.ts - a.ts); // 최신순
      // after sort
      const r2 = tsRange(arr);
      const inv2 = countDescInversions(arr);
      // quiet
      // ⬇︎ 파일명은 그대로 유지. 구버전 엔트리엔 file을 보강.
      for (const e of arr) {
        if (!(e as any).file) {
          const cand = (e as any).path || e.source || '';
          (e as any).file = path.basename(String(cand));
        }
        // source는 덮어쓰지 않음(표시·필터 모두 file/path 우선 사용)
      }
    }

    // 7) k-way 병합으로 정확히 target개만 추출
    // quiet
    type WarmItem = { ts: number; entry: LogEntry; typeKey: string; idx: number };
    const heap = new MaxHeap<WarmItem>((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts; // 큰 ts 우선
      if (a.typeKey !== b.typeKey) return a.typeKey < b.typeKey ? -1 : 1;
      return b.idx - a.idx;
    });
    for (const k of typeKeys) {
      const arr = buffers.get(k)!;
      if (arr.length) heap.push({ ts: arr[0].ts, entry: arr[0], typeKey: k, idx: 0 });
    }
    const out: LogEntry[] = [];
    while (!heap.isEmpty() && out.length < target && !aborted()) {
      const top = heap.pop()!;
      out.push(top.entry);
      const arr = buffers.get(top.typeKey)!;
      const nextIdx = top.idx + 1;
      if (nextIdx < arr.length) {
        heap.push({ ts: arr[nextIdx].ts, entry: arr[nextIdx], typeKey: top.typeKey, idx: nextIdx });
      }
    }
    // quiet
    if (out.length < target) {
      // quiet
    }
    return out;
  });
}
