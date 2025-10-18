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

// Manager 선행 웜업 호출을 위해 필요한 필드만 분리
export type WarmupOptions = Pick<MergeOptions, 'dir' | 'signal' | 'warmupPerTypeLimit' | 'warmupTarget'>;

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

    // ─────────────────────────────────────────────────────────────────────────
    // 0) (호환) 워밍업 선행패스
    //    Manager-선행 웜업 경로에서는 mergeDirectory를 warmup:false로 호출하므로 여기 미실행
    if (opts.warmup && (typeof opts.onWarmupBatch === 'function' || typeof opts.onBatch === 'function')) {
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
          log.info(`warmup: delivered initial batch (n=${warmLogs.length})`);
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
      `T1: mergeDirectory start dir=${opts.dir} files=${files.length} reverse=${!!opts.reverse} batchSize=${batchSize}`,
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
    log.info(`T1: created intermediates merged=${mergedDir}${rawDir ? ` raw=${rawDir}` : ''}`);

    // 1) 타입 그룹화(.log 전용)
    const grouped = groupByType(files);
    log.info(`T1: type groups=${grouped.size}`);

    // 2) 타입별 메모리 로딩(최신→오래된), 타임존 보정(국소), merged(JSONL) 저장(최신순)
    for (const [typeKey, fileList] of grouped) {
      if (opts.signal?.aborted) break;

      log.debug(`T1: processing type=${typeKey} files=${fileList.length}`);
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
      log.info(`T1: loaded ${logs.length} logs for type=${typeKey}`);

      // (옵션) RAW 저장 — 최신→오래된 그대로
      if (rawDir && logs.length) {
        const rawFile = path.join(rawDir, `${typeKey}.raw.jsonl`);
        for (const logEntry of logs) {
          await fs.promises.appendFile(rawFile, JSON.stringify(logEntry) + '\n');
        }
      }

      // 타임존 보정 (국소 소급 보정 지원)
      const tzc = new TimezoneCorrector(typeKey);
      let tzRetroSegmentsApplied = 0;
      for (let i = 0; i < logs.length; i++) {
        const corrected = tzc.adjust(logs[i].ts, i);
        logs[i].ts = corrected;

        // 복귀가 확정되면 방금까지의 suspected 구간만 Δoffset 적용
        const segs = tzc.drainRetroSegments();
        if (segs.length) {
          tzRetroSegmentsApplied += segs.length;
          for (const seg of segs) {
            for (let j = seg.start; j <= Math.min(seg.end, logs.length - 1); j++) {
              logs[j].ts += seg.deltaMs;
            }
          }
        }
      }
      // 파일 끝에서 suspected가 남아있으면 폐기(복귀 증거 없음)
      tzc.finalizeSuspected();
      log.debug?.(`T1: timezone correction type=${typeKey} retroSegmentsApplied=${tzRetroSegmentsApplied}`);

      // ⬇️ JSONL 저장은 "최신→오래된(내림차순)"으로 저장
      logs.sort((a, b) => b.ts - a.ts);
      const mergedFile = path.join(mergedDir, `${typeKey}.jsonl`);
      for (const logEntry of logs) {
        await fs.promises.appendFile(mergedFile, JSON.stringify(logEntry) + '\n');
      }
      log.info(`T1: saved ${logs.length} logs to ${mergedFile} (desc ts)`);
    }

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
    log.info(`T1: cursors ready types=${cursors.size}`);

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
    log.info(`T1: done emitted=${emitted}`);
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
// 워밍업 선행패스 구현 (균등+재분배 / 타임존 보정 / 정확히 target개 방출)
// - 타입 수에 맞춰 균등 할당 후 남는 몫(remainder) 분배
// - 어떤 타입이 모자라면 잔여 할당을 다른 타입으로 "재분배"
// - 타입별 버퍼는 최신→오래된 순으로 수집 후 타임존 보정, 보정 후 최신순(ts desc) 정렬
// - 최종 k-way 병합으로 정확히 target개만 반환
// ⬇️ Manager에서 직접 호출할 수 있도록 export + LogEntry[] 반환
export async function warmupTailPrepass(
  opts: WarmupOptions
): Promise<LogEntry[]> {
  const { dir, signal } = opts;
  const logger = getLogger('LogFileIntegration');
  logger.info(`warmup(T0): start dir=${dir}`);
  const target = Math.max(1, Number(opts.warmupTarget ?? 500));
  const perTypeCap = Number.isFinite(opts.warmupPerTypeLimit ?? NaN)
    ? Math.max(1, Number(opts.warmupPerTypeLimit))
    : Number.POSITIVE_INFINITY;
  const aborted = () => !!signal?.aborted;
  if (aborted()) return [];

  // 1) 입력 로그 파일 수집 → 타입별 그룹화(회전 파일 포함)
  const names = await listInputLogFiles(dir);
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
  logger.info(
    `warmup(T0): plan target=${target} types=${T} base=${base} rem=${target % T} cap=${isFinite(perTypeCap) ? perTypeCap : 'INF'}`
  );
  logger.debug?.(
    `warmup(T0): per-type allocation → ` +
    typeKeys.map(k => `${k}:${alloc.get(k)}`).join(', ')
  );

  // 3) 타입별 tail walker 준비
  class TypeTailWalker {
    private idx = 0;
    private rr: ReverseLineReader | null = null;
    private exhausted = false;
    constructor(private baseDir: string, private files: string[]) {}
    get isExhausted() { return this.exhausted; }
    private async ensureReader() {
      while (!this.rr && this.idx < this.files.length) {
        const fp = path.join(this.baseDir, this.files[this.idx]);
        try {
          this.rr = await ReverseLineReader.open(fp);
        } catch {
          // 파일 오픈 실패 시 다음 파일로
          this.idx++;
        }
      }
      if (!this.rr && this.idx >= this.files.length) this.exhausted = true;
    }
    async next(n: number): Promise<{ line: string; file: string }[]> {
      if (this.exhausted) return [];
      await this.ensureReader();
      const out: { line: string; file: string }[] = [];
      while (out.length < n && !this.exhausted) {
        if (!this.rr) { this.exhausted = true; break; }
        const line = await this.rr.nextLine();
        if (line === null) {
          // 현재 파일 끝 → 닫고 다음 파일
          try { await this.rr.close(); } catch {}
          this.rr = null;
          this.idx++;
          await this.ensureReader();
          continue;
        }
        out.push({ line, file: this.files[this.idx] });
      }
      return out;
    }
  }

  // 타입별 워커/버퍼 초기화
  const walkers = new Map<string, TypeTailWalker>();
  const buffers = new Map<string, LogEntry[]>();
  for (const k of typeKeys) {
    const files = grouped.get(k)!.slice().sort(compareLogOrderDesc);
    walkers.set(k, new TypeTailWalker(dir, files));
    buffers.set(k, []);
  }
  logger.info(`warmup(T0): walkers ready for ${typeKeys.length} types`);

  // 헬퍼: 라인 -> LogEntry (파일명을 source로)
  const toEntry = (fileName: string, line: string): LogEntry => {
    const full = path.join(dir, fileName);
    return lineToEntry(full, line);
  };

  // 4) 1차 수집: 균등 할당만큼 per-type 로딩
  const batchRead = async (typeKey: string, need: number) => {
    if (need <= 0) return 0;
    const w = walkers.get(typeKey)!;
    let got = 0;
    // 한 번에 너무 큰 I/O를 피하려고 소형 청크로 읽음
    const CHUNK = 64;
    while (got < need && !w.isExhausted && !aborted()) {
      const n = Math.min(CHUNK, need - got);
      const part = await w.next(n);
      if (!part.length) break;
      const buf = buffers.get(typeKey)!;
      for (const { line, file } of part) buf.push(toEntry(file, line));
      got += part.length;
    }
    return got;
  };

  let total = 0;
  for (const k of typeKeys) {
    const want = alloc.get(k)!;
    total += await batchRead(k, want);
  }

  // 5) 재분배: target까지 부족하면 남은 타입에서 추가 로딩
  logger.debug?.(`warmup(T0): primary load total=${total}, target=${target}`);
  let deficit = Math.max(0, target - total);
  if (deficit > 0) {
    // 현재 각 타입이 cap에 도달했는지 계산
    const room = () =>
      typeKeys
        .map(k => ({ k, room: Math.max(0, (perTypeCap === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : perTypeCap) - buffers.get(k)!.length) }))
        .filter(x => x.room > 0);
    let slots = room();
    // 라운드로빈으로 1~CHUNK씩 분배
    let i = 0;
    const CHUNK = 64;
    while (deficit > 0 && slots.length && !aborted()) {
      const { k, room: r } = slots[i % slots.length];
      const take = Math.min(CHUNK, r, deficit);
      if (take > 0) {
        const got = await batchRead(k, take);
        deficit -= got;
        total += got;
        logger.debug?.(`warmup(T0): rebalanced ${k} +=${got}, remain deficit=${deficit}`);
      }
      i++;
      slots = room();
    }
  }

  if (total === 0) return [];

  logger.info(`warmup(T0): collected total=${total} (before TZ correction)`);
  // 6) 타입별 타임존 보정 + 최신순 정렬 + source 통일
  for (const k of typeKeys) {
    const arr = buffers.get(k)!;
    if (!arr.length) continue;
    const tzc = new TimezoneCorrector(k);
    let tzRetroSegmentsApplied = 0;
    for (let i = 0; i < arr.length; i++) {
      const corrected = tzc.adjust(arr[i].ts, i);
      arr[i].ts = corrected;
      const segs = tzc.drainRetroSegments();
      if (segs.length) {
        tzRetroSegmentsApplied += segs.length;
        for (const seg of segs) {
          for (let j = seg.start; j <= Math.min(seg.end, arr.length - 1); j++) {
            arr[j].ts += seg.deltaMs;
          }
        }
      }
    }
    tzc.finalizeSuspected();
    logger.debug?.(`warmup(T0): timezone correction type=${k} retroSegmentsApplied=${tzRetroSegmentsApplied}`);
    arr.sort((a, b) => b.ts - a.ts); // 최신순
    // 파일 기반(JSONL) 경로와 동일하게 source를 typeKey로 통일
    for (const e of arr) (e as any).source = k;
  }

  // 7) k-way 병합으로 정확히 target개만 추출
  logger.info(`warmup(T0): k-way merge to emit=${target}`);
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
  logger.info(`warmup(T0): prepared lines=${out.length}`);
  if (out.length < target) {
    logger.info(`warmup(T0): dataset smaller than target (out=${out.length} < target=${target}) — will short-circuit T1 if total is known and ≤ out`);
  }
  logger.info(`warmup(T0): prepared lines=${out.length}`);
  return out;
}// 파일 꼬리에서 최대 N줄을 빠르게 읽음 (대용량 안전)
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
      // 맨 뒤쪽(파일 끝쪽)부터 수집 → 결과는 "최신이 앞" 순서가 됨
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
