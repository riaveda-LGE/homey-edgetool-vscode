// === src/core/logs/LogFileIntegration.ts ===
import * as fs from 'fs';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';

import type { LogEntry } from '@ipc/messages';
import { DEFAULT_BATCH_SIZE } from '../../shared/const.js';
import { ErrorCategory, XError } from '../../shared/errors.js';
import { getLogger } from '../logging/extension-logger.js';
import { guessLevel, parseTs } from './time/TimeParser.js';
import { TimezoneCorrector } from './time/TimezoneHeuristics.js';

const log = getLogger('LogFileIntegration');

/* ──────────────────────────────────────────────────────────────────────────
 * 공개 API
 * ────────────────────────────────────────────────────────────────────────── */

export type MergeOptions = {
  dir: string;
  /** false(기본) = 최신→오래된 순으로 병합
   *   true        = 오래된→최신 (디버그용; k-way 대신 순차합치기로 전환)
   */
  reverse?: boolean;
  signal?: AbortSignal;
  onBatch: (logs: LogEntry[]) => void;
  onWarmupBatch?: (logs: LogEntry[]) => void;
  batchSize?: number;
  mergedDirPath?: string; // 중간 산출물(JSONL) 저장 위치
  rawDirPath?: string;    // (옵션) 보정 전 RAW 저장 위치
  /** warmup 선행패스 사용 여부 (기본: false, 상위 FeatureFlags로 채워짐) */
  warmup?: boolean;
  /** warmup 모드일 때 타입별 최대 선행 읽기 라인수 (기본: 500 등) */
  warmupPerTypeLimit?: number;
  /** warmup 모드일 때 최초 즉시 방출 목표치 (기본: 500) */
  warmupTarget?: number;
};

/**
 * 디렉터리를 읽어 **최신순**으로 병합해 batch 콜백으로 흘려보낸다.
 * 새로운 방식: 타입별 메모리 로딩 → 최신→오래된(그대로) → 타임존 보정(국소 소급 보정 지원) →
 *             merged(JSONL, 최신순) 저장 → JSONL을 순방향으로 100줄씩 읽어 k-way 병합
 */
export async function mergeDirectory(opts: MergeOptions) {
  try {
    const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);

    // ───────────────────────────────────────────────────────────────────────────
    // 0) 워밍업 선행패스: 각 "타입의 최신 파일" 꼬리에서 조금만 읽어 500줄 ASAP 방출
    //    - 디스크 쓰기/manifest 갱신 없음
    //    - 실패/중단 시에도 본 패스로 안전하게 폴백
    if (opts.warmup && (typeof opts.onWarmupBatch === 'function' || typeof opts.onBatch === 'function')) {
      try {
        const delivered = await warmupTailPrepass(opts);
        if (delivered) {
          log.info('warmup: delivered initial batch (memory-only)');
        } else {
          log.debug?.('warmup: skipped or not enough lines');
        }
      } catch (e: any) {
        log.warn(`warmup: failed (${e?.message ?? e}) — fallback to full merge`);
      }
    }

    // ── 2) 기존 k-way/표준 패스 그대로 ───────────────────────────────────
    // 입력 로그(.log/.log.N/.txt) 수집
    const files = await listInputLogFiles(opts.dir);
    log.info(
      `mergeDirectory: start dir=${opts.dir} files=${files.length} reverse=${!!opts.reverse} batchSize=${batchSize}`,
    );
    if (!files.length) {
      log.warn('mergeDirectory: no log files to merge');
      return;
    }

    // 디버그용: 오래된→최신 순차 스트리밍
    if (opts.reverse) {
      const ordered = files.sort(compareLogOrderAsc); // .2 → .1 → .log
      log.debug?.(`mergeDirectory: reverse mode, files=${ordered.length}`);
      for (const f of ordered) {
        const full = path.join(opts.dir, f);
        await streamFileForward(
          full,
          (entries: LogEntry[]) => opts.onBatch(entries),
          batchSize,
          opts.signal,
        );
        if (opts.signal?.aborted) {
          log.warn('mergeDirectory: aborted');
          break;
        }
      }
      return;
    }

    // 중간 산출물 디렉터리
    const mergedDir = opts.mergedDirPath || path.join(opts.dir, 'merged');
    if (fs.existsSync(mergedDir)) fs.rmSync(mergedDir, { recursive: true, force: true });
    await fs.promises.mkdir(mergedDir, { recursive: true });

    const rawDir = opts.rawDirPath;
    if (rawDir) {
      if (fs.existsSync(rawDir)) fs.rmSync(rawDir, { recursive: true, force: true });
      await fs.promises.mkdir(rawDir, { recursive: true });
    }
    log.info(`mergeDirectory: created merged dir=${mergedDir}${rawDir ? ` raw dir=${rawDir}` : ''}`);

    // 1) 타입 그룹화(.log 전용)
    const grouped = groupByType(files);
    log.info(`mergeDirectory: type groups=${grouped.size}`);

    // 2) 타입별 메모리 로딩(최신→오래된), 타임존 보정(국소), merged(JSONL) 저장(최신순)
    for (const [typeKey, fileList] of grouped) {
      if (opts.signal?.aborted) break;

      log.debug(`mergeDirectory: processing type=${typeKey} files=${fileList.length}`);
      const logs: LogEntry[] = [];

      // 최신 파일부터( *.log → *.log.1 → *.log.2 … )
      const orderedFiles = fileList.sort(compareLogOrderDesc);

      // 모든 파일을 ReverseLineReader로 읽음 → 각 파일 끝→시작(최신→오래된)으로 라인 푸시
      for (const fileName of orderedFiles) {
        const fullPath = path.join(opts.dir, fileName);
        const rr = await ReverseLineReader.open(fullPath);
        let line: string | null;
        while ((line = await rr.nextLine()) !== null) {
          const entry = lineToEntry(fileName, line);
          logs.push(entry); // 전체 logs가 최신→오래된 순
        }
        await rr.close();
      }
      log.info(`mergeDirectory: loaded ${logs.length} logs for type=${typeKey}`);

      // (옵션) RAW 저장 — 최신→오래된 그대로
      if (rawDir && logs.length) {
        const rawFile = path.join(rawDir, `${typeKey}.raw.jsonl`);
        for (const logEntry of logs) {
          await fs.promises.appendFile(rawFile, JSON.stringify(logEntry) + '\n');
        }
      }

      // 타임존 보정 (국소 소급 보정 지원)
      const tzc = new TimezoneCorrector(typeKey);
      for (let i = 0; i < logs.length; i++) {
        const corrected = tzc.adjust(logs[i].ts, i);
        logs[i].ts = corrected;

        // 복귀가 확정되면 방금까지의 suspected 구간만 Δoffset 적용
        const segs = tzc.drainRetroSegments();
        if (segs.length) {
          for (const seg of segs) {
            for (let j = seg.start; j <= Math.min(seg.end, logs.length - 1); j++) {
              logs[j].ts += seg.deltaMs;
            }
          }
        }
      }
      // 파일 끝에서 suspected가 남아있으면 폐기(복귀 증거 없음)
      tzc.finalizeSuspected();

      // ⬇️ JSONL 저장은 "최신→오래된(내림차순)"으로 저장
      logs.sort((a, b) => b.ts - a.ts);
      const mergedFile = path.join(mergedDir, `${typeKey}.jsonl`);
      for (const logEntry of logs) {
        await fs.promises.appendFile(mergedFile, JSON.stringify(logEntry) + '\n');
      }
      log.info(`mergeDirectory: saved ${logs.length} logs to ${mergedFile} (desc ts)`);
    }

    // 3) merged(JSONL)에서 타입별로 **순방향** 100줄씩 읽어 k-way 병합(최신→오래된)
    const mergedFiles = await listMergedJsonlFiles(mergedDir); // ← .jsonl 전용
    if (!mergedFiles.length) {
      log.warn(`mergeDirectory: no merged jsonl files in ${mergedDir}`);
    }

    // 파일명에서 타입키 추출( clip.jsonl → clip )
    const cursors = new Map<string, MergedCursor>();
    for (const fileName of mergedFiles) {
      const typeKey = typeKeyFromJsonl(fileName);
      const fullPath = path.join(mergedDir, fileName);
      const cursor = await MergedCursor.create(fullPath, typeKey);
      cursors.set(typeKey, cursor);
    }

        // k-way max-heap: ts 큰 것(최신) 우선
    const heap = new MaxHeap<HeapItem>((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      if (a.typeKey !== b.typeKey) return a.typeKey < b.typeKey ? -1 : 1;
      return b.seq - a.seq; // 동일 ts일 때 먼저 읽힌 것(작은 seq)을 우선
    });

    // 초기 주입: 각 타입에서 100줄(순방향=가장 최신부터)
    for (const [typeKey, cursor] of cursors) {
      const batch = await cursor.nextBatch(100);
      for (const item of batch) heap.push({ ...item, typeKey, seq: cursor.seq++ });
    }

    let emitted = 0;
    const outBatch: LogEntry[] = [];
    while (!heap.isEmpty()) {
      if (opts.signal?.aborted) {
        log.warn('mergeDirectory: aborted');
        break;
      }
      const top = heap.pop()!;
      outBatch.push(top.entry);

      if (outBatch.length >= batchSize) {
        emitted += outBatch.length;
        opts.onBatch(outBatch.splice(0, outBatch.length));
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
    }

    // Abort 시 열려 있는 리더 자원 정리
    if (opts.signal?.aborted) {
      for (const [, cursor] of cursors) await cursor.close();
    }
    log.info(`mergeDirectory: done emitted=${emitted}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`mergeDirectory: error dir=${opts.dir} ${msg}`);
    throw new XError(
      ErrorCategory.Path,
      `Failed to merge log directory ${opts.dir}: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 입력 로그 파일(.log/.log.N/.txt) 유틸
 * ────────────────────────────────────────────────────────────────────────── */

export async function listInputLogFiles(dir: string): Promise<string[]> {
  try {
    const names = await fs.promises.readdir(dir);
    const results: string[] = [];
    for (const name of names) {
      const full = path.join(dir, name);
      if (!(await isRegularFile(full))) continue;
      if (!/\.log(\.\d+)?$/i.test(name) && !/\.txt$/i.test(name)) continue;
      results.push(name);
    }
    return results;
  } catch (e) {
    throw new XError(
      ErrorCategory.Path,
      `Failed to list log files in ${dir}: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

/** 병합 전 총 라인수 계산 (참고용) — 최신 파일부터 세되 결과는 단순 합 */
export async function countTotalLinesInDir(
  dir: string,
): Promise<{ total: number; files: { name: string; lines: number }[] }> {
  const files = await listInputLogFiles(dir);
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
}

/* ──────────────────────────────────────────────────────────────────────────
 * 내부 유틸
 * ────────────────────────────────────────────────────────────────────────── */

function compareLogOrderDesc(a: string, b: string) {
  // homey-pro.log > .log.1 > .log.2 … (숫자 작을수록 최신)
  return numberSuffix(a) - numberSuffix(b);
}
function compareLogOrderAsc(a: string, b: string) {
  return -compareLogOrderDesc(a, b);
}
function numberSuffix(name: string) {
  const m = name.match(/\.log(?:\.(\d+))?$/);
  if (!m) return 9999;
  return m[1] ? parseInt(m[1], 10) : -1;
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

/** 타입키 추출: 'homey-pro.log.1' -> 'homey-pro' / 'clip.log' -> 'clip' */
function typeKeyOf(name: string): string {
  const m = name.match(/^(.*)\.log(?:\.\d+)?$/i);
  return m ? m[1] : name;
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
 * 순방향(오래된→최신) 스트리밍 — reverse=true 시 사용
 * ────────────────────────────────────────────────────────────────────────── */
async function streamFileForward(
  filePath: string,
  emit: (batch: LogEntry[]) => void,
  batchSize: number,
  signal?: AbortSignal,
) {
  const rs = fs.createReadStream(filePath, { encoding: 'utf8' });
  let residual = '';
  const batch: LogEntry[] = [];

  const onAbort = () => {
    try {
      rs.close();
    } catch {}
  };
  signal?.addEventListener('abort', onAbort);

  await new Promise<void>((resolve, reject) => {
    rs.on('data', (chunk: string | Buffer) => {
      if (signal?.aborted) return;
      const text = residual + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
      const parts = text.split(/\r?\n/);
      residual = parts.pop() ?? '';
      for (const line of parts) {
        if (!line) continue;
        const e = lineToEntry(filePath, line);
        batch.push(e);
        if (batch.length >= batchSize) emit(batch.splice(0, batch.length));
      }
    });
    rs.on('end', () => {
      if (residual) {
        const e = lineToEntry(filePath, residual);
        batch.push(e);
      }
      // Abort 되었다면 끝부분 잔여 배치도 내보내지 않음
      if (!signal?.aborted && batch.length) emit(batch.splice(0, batch.length));
      signal?.removeEventListener('abort', onAbort);
      resolve();
    });
    rs.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new XError(ErrorCategory.Path, `Failed to stream log file ${filePath}: ${String(e)}`));
    });
  });
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
      this.buffer = buf.toString('utf8') + this.buffer;
      this.pos = start;
    }
  }

  async close() {
    if (this.fh !== null) {
      try { await this.fh.close(); } catch {}
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

  constructor(public readonly filePath: string) {
    this.rs = fs.createReadStream(filePath, { encoding: 'utf8' });
    this.rs.on('data', (chunk) => {
      this.buffer += chunk;
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
      if (this.queue.length) { out.push(this.queue.shift()!); continue; }
      if (this.errored) throw this.errored;
      if (this.ended) break;
      await this.waitForData();
    }
    return out;
  }

  async close() {
    try { this.rs.close(); } catch {}
  }
}

/** JSONL에서 "앞에서부터" size줄 읽기 */
class MergedCursor {
  private reader: ForwardLineReader | null = null;
  public seq = 0;
  public isExhausted = false;

  private constructor(public typeKey: string) {}

  async close() {
    if (this.reader) { await this.reader.close(); this.reader = null; }
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
        entry.source = this.typeKey; // source를 typeKey로 통일
        batch.push({ ts: entry.ts, entry });
      } catch {
        // malformed 라인은 건너뜀
      }
    }
    return batch;
  }
}

type HeapItem = { ts: number; entry: LogEntry; typeKey: string; seq: number };

/** 간단 max-heap 구현 */
class MaxHeap<T> {
  private arr: T[] = [];
  constructor(private cmp: (a: T, b: T) => number) {}
  size() { return this.arr.length; }
  isEmpty() { return this.arr.length === 0; }
  peek() { return this.arr[0]; }
  push(v: T) { this.arr.push(v); this.up(this.arr.length - 1); }
  pop(): T | undefined {
    if (this.arr.length === 0) return undefined;
    const top = this.arr[0];
    const last = this.arr.pop()!;
    if (this.arr.length) { this.arr[0] = last; this.down(0); }
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
      let l = i * 2 + 1, r = l + 1, m = i;
      if (l < n && this.cmp(this.arr[l], this.arr[m]) > 0) m = l;
      if (r < n && this.cmp(this.arr[r], this.arr[m]) > 0) m = r;
      if (m === i) break;
      [this.arr[i], this.arr[m]] = [this.arr[m], this.arr[i]];
      i = m;
    }
  }
}

function lineToEntry(filePath: string, line: string): LogEntry {
  return {
    id: Date.now(), // 간단 id
    ts: parseTs(line) ?? Date.now(),
    level: guessLevel(line),
    type: 'system',
    source: path.basename(filePath),
    text: line,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 워밍업 선행패스 구현
// - 각 타입별 "최신 파일"만 대상으로 tail에서 최대 N줄만 읽어 메모리에 모음
// - 엄밀한 k-way 정렬 대신 경량 interleave(라운드로빈)로 혼합 → 목표치에 도달하면 즉시 onBatch
// - manifest/청크 파일 갱신 없음 (I/O 최소화)
async function warmupTailPrepass(opts: MergeOptions): Promise<boolean> {
  const { dir, signal } = opts;
  const log = getLogger('LogFileIntegration');
  const perType = Math.max(1, Number(opts.warmupPerTypeLimit ?? 500));
  const target = Math.max(1, Number(opts.warmupTarget ?? 500));

  if (!opts.onWarmupBatch && !opts.onBatch) return false;

  // 중단 체크 헬퍼
  const aborted = () => !!signal?.aborted;
  if (aborted()) return false;

  // 입력 디렉토리의 파일 나열(하위 폴더는 무시)
  let files: string[] = [];
  try {
    const names = await fs.promises.readdir(dir, { withFileTypes: true });
    files = names
      .filter((d) => d.isFile())
      .map((d) => path.join(dir, d.name));
  } catch (e) {
    log.warn(`warmup: readdir failed: ${String(e)}`);
    return false;
  }
  if (files.length === 0) return false;

  // 타입 추론: 파일명 키워드 기반(간단 휴리스틱)
  const inferType = (p: string): string => {
    const b = path.basename(p).toLowerCase();
    if (b.includes('kernel')) return 'kernel';
    if (b.includes('homey')) return 'homey-pro';
    if (b.includes('matter')) return 'matter';
    if (b.includes('z3')) return 'z3gateway';
    if (b.includes('cpcd')) return 'cpcd';
    return 'other';
  };

  // 타입별 최신 파일만 선택
  const groups = new Map<string, { file: string; mtime: number }>();
  await Promise.all(files.map(async (f) => {
    try {
      const st = await fs.promises.stat(f);
      if (!st.isFile()) return;
      const t = inferType(f);
      const cur = groups.get(t);
      if (!cur || st.mtimeMs > cur.mtime) groups.set(t, { file: f, mtime: st.mtimeMs });
    } catch {}
  }));

  const picks = [...groups.values()].map(x => x.file);
  if (picks.length === 0) return false;
  log.info(`warmup: picked latest files per type: ${picks.map(p=>path.basename(p)).join(', ')}`);
  if (aborted()) return false;

  // 각 파일 꼬리에서 최대 perType 줄만 tail
  const perTypeLines: LogEntry[][] = [];
  for (const f of picks) {
    if (aborted()) return false;
    try {
      const raw = await tailLines(f, perType);
      // 최신이 뒤쪽이라고 가정 → 뒤→앞 역순으로 최신우선화
      raw.reverse();
      const src = path.basename(f);
      const type = inferType(f) as any;
      const items: LogEntry[] = raw.map((line, i) => ({
        id: Date.now() + i,
        ts: Date.now(),        // 엄밀한 정렬은 본 패스에서 수행 (여긴 표시용)
        type,
        source: src,
        text: line,
      }));
      perTypeLines.push(items);
      log.debug?.(`warmup: tail ${src} -> ${items.length} lines`);
    } catch (e) {
      log.warn(`warmup: tail failed for ${path.basename(f)}: ${String(e)}`);
    }
  }
  if (perTypeLines.length === 0) return false;

  // 라운드로빈 interleave로 혼합 → target까지 자름
  const mixed: LogEntry[] = [];
  let idx = 0;
  while (mixed.length < target) {
    let advanced = false;
    for (const arr of perTypeLines) {
      if (arr[idx]) {
        mixed.push(arr[idx]);
        advanced = true;
        if (mixed.length >= target) break;
      }
    }
    if (!advanced) break; // 더 뽑을 게 없음
    idx++;
    if (aborted()) return false;
  }

  if (mixed.length === 0) return false;
  const out = mixed.slice(0, Math.min(target, mixed.length));
  try {
    // ✅ 워밍업 전용 콜백이 있으면 그것만 호출(디스크/manifest 기록 금지)
    if (opts.onWarmupBatch) {
      opts.onWarmupBatch(out);
    } else if (opts.onBatch) {
      // ⛳️ 하위호환: onWarmupBatch 미구현인 호출자에 한해 onBatch로 전달
      // (LogSessionManager 경로에서는 onWarmupBatch를 사용하므로 중복기록 없음)
      opts.onBatch(out);
    }
    return true;
  } catch {
    return false;
  }
}

// 파일 꼬리에서 최대 N줄을 빠르게 읽음 (대용량 안전)
async function tailLines(filePath: string, maxLines: number, chunkSize = 64 * 1024): Promise<string[]> {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    let pos = Math.max(0, stat.size);
    let buf = '';
    const lines: string[] = [];
    while (pos > 0 && lines.length <= maxLines) {
      const readSize = Math.min(chunkSize, pos);
      pos -= readSize;
      const b = Buffer.allocUnsafe(readSize);
      await fh.read(b, 0, readSize, pos);
      buf = b.toString('utf8') + buf;
      // 줄 단위로 분해(너무 많이 쌓이지 않게 중간중간 잘라내기)
      const parts = buf.split(/\r?\n/);
      // 마지막 조각은 다음 루프에서 이어붙일 수 있도록 유지
      buf = parts.shift() || '';
      // 맨 뒤쪽(파일 끝쪽)부터 수집
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].length === 0) continue;
        lines.push(parts[i]);
        if (lines.length >= maxLines) break;
      }
    }
    // 남은 buf가 의미 있는 한 줄이면 추가
    if (buf && lines.length < maxLines) lines.push(buf);
    return lines.slice(0, maxLines);
  } finally {
    await fh.close();
  }
}
