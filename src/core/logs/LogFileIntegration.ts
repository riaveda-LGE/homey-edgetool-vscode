// === src/core/logs/LogFileIntegration.ts ===
import * as fs from 'fs';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';

import type { LogEntry } from '../../extension/messaging/messageTypes.js';
import { DEFAULT_BATCH_SIZE } from '../../shared/const.js';
import { ErrorCategory,XError } from '../../shared/errors.js';
import { getLogger } from '../logging/extension-logger.js';
import { guessLevel,parseTs } from './time/TimeParser.js';
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
  batchSize?: number;
};

/**
 * 디렉터리를 읽어 **최신순**으로 병합해 batch 콜백으로 흘려보낸다.
 * - 타입(파일 prefix)별로 타임존 점프 보정 후 k-way merge
 * - reverse=true면 기존 순차합치기(오래된→최신)로 degrade (디버깅/비상용)
 */
export async function mergeDirectory(opts: MergeOptions) {
  try {
    const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
    const files = await listLogFiles(opts.dir);
    log.info(`mergeDirectory: start dir=${opts.dir} files=${files.length} reverse=${!!opts.reverse} batchSize=${batchSize}`);
    if (!files.length) {
      log.warn('mergeDirectory: no log files to merge');
      return;
    }

    if (opts.reverse) {
      // 안전모드: 오래된→최신 순차 스트리밍
      const ordered = files.sort(compareLogOrderAsc); // .2 → .1 → .log
      log.debug?.(`mergeDirectory: reverse mode, files=${ordered.length}`);
      for (const f of ordered) {
        const full = path.join(opts.dir, f);
        await streamFileForward(full, (entries: LogEntry[]) => opts.onBatch(entries), batchSize, opts.signal);
        if (opts.signal?.aborted) { log.warn('mergeDirectory: aborted'); break; }
      }
      return;
    }

    // 1) 타입 그룹화 (예: homey-pro.log.*, clip.log.*)
    const grouped = groupByType(files);
    log.info(`mergeDirectory: type groups=${grouped.size}`);

    // 2) 타입별 역방향 커서(최신→과거) + 타임존 보정기
    const cursors = new Map<string, TypeCursor>();
    for (const [typeKey, list] of grouped) {
      const ordered = list.sort(compareLogOrderDesc); // .log → .1 → .2 (최신 파일부터)
      log.debug?.(`cursor.create type=${typeKey} files=${ordered.length}`);
      const cursor = await TypeCursor.create(opts.dir, typeKey, ordered);
      cursors.set(typeKey, cursor);
    }

    // 3) k-way max-heap (보정된 ts 내림차순)
    const heap = new MaxHeap<HeapItem>((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts; // 큰 ts가 위로
      // tie-breaker: 타입명/시퀀스
      if (a.typeKey !== b.typeKey) return a.typeKey < b.typeKey ? -1 : 1;
      return a.seq - b.seq;
    });

    // 초기 주입
    for (const [typeKey, c] of cursors) {
      const first = await c.next();
      if (first) heap.push({ ...first, typeKey, seq: c.seq });
    }

    let emitted = 0;
    const batch: LogEntry[] = [];
    while (!heap.isEmpty()) {
      if (opts.signal?.aborted) { log.warn('mergeDirectory: aborted'); break; }
      const top = heap.pop()!;
      batch.push(top.entry);

      // 채워지면 배출
      if (batch.length >= batchSize) {
        emitted += batch.length;
        opts.onBatch(batch.splice(0, batch.length));
      }

      // 같은 타입에서 다음 한 줄
      const c = cursors.get(top.typeKey)!;
      const n = await c.next();
      if (n) heap.push({ ...n, typeKey: top.typeKey, seq: c.seq });
    }

    if (batch.length) {
      emitted += batch.length;
      opts.onBatch(batch);
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

/** 디렉터리의 병합 후보 로그 파일 목록을 반환 (정상 파일만) */
export async function listLogFiles(dir: string): Promise<string[]> {
  try {
    const names = await fs.promises.readdir(dir);
    const results: string[] = [];
    for (const name of names) {
      const full = path.join(dir, name);
      if (!(await isRegularFile(full))) {
        log.debug?.(`skip non-regular entry: ${full}`);
        continue;
      }
      if (!/\.log(\.\d+)?$/i.test(name) && !/\.txt$/i.test(name)) {
        log.debug?.(`skip by extension: ${full}`);
        continue;
      }
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

/** 병합 전 총 라인수 계산 (오래된→최신 순으로 전체 카운트) */
export async function countTotalLinesInDir(
  dir: string,
): Promise<{ total: number; files: { name: string; lines: number }[] }> {
  const files = await listLogFiles(dir);
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

/** 빠른 라인 카운트(바이너리 스트림에서 '\n' 카운팅) — 파일 마지막이 개행이 아니면 +1 보정 */
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
      // 마지막이 개행이 아니고, 내용이 존재하면 마지막 줄 +1
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

/** 파일 목록을 타입키별로 묶기 */
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

  const onAbort = () => { try { rs.close(); } catch {} };
  signal?.addEventListener('abort', onAbort);

  rs.on('data', (chunk: string | Buffer) => {
    if (signal?.aborted) return;
    const text = residual + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
    const parts = text.split(/\r?\n/);
    residual = parts.pop() ?? '';
    for (const line of parts) {
      if (!line) continue;
      const e = lineToEntry(filePath, line);
      batch.push(e);
      if (batch.length >= batchSize) {
        emit(batch.splice(0, batch.length));
      }
    }
  });
  rs.on('end', () => {
    if (residual) {
      const e = lineToEntry(filePath, residual);
      batch.push(e);
    }
    if (batch.length) emit(batch.splice(0, batch.length));
    signal?.removeEventListener('abort', onAbort);
  });
  rs.on('error', (e) => {
    signal?.removeEventListener('abort', onAbort);
    throw new XError(ErrorCategory.Path, `Failed to stream log file ${filePath}: ${String(e)}`);
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * 최신→오래된 역방향 라인 리더 + 타입 커서 + max-heap
 * ────────────────────────────────────────────────────────────────────────── */

class ReverseLineReader {
  private fh: FileHandle | null = null;
  private fileSize = 0;
  private pos = 0;         // 읽기 시작 오프셋 (파일 끝에서 거꾸로)
  private buffer = '';     // 누적 버퍼
  private readonly chunkSize = 64 * 1024;

  // ⬇️ 외부에서 소스명 뽑아 쓸 수 있도록 공개
  constructor(public readonly filePath: string) {}

  static async open(filePath: string) {
    const r = new ReverseLineReader(filePath);
    const st = await fs.promises.stat(filePath);
    r.fileSize = st.size;
    r.pos = st.size;
    r.fh = await fs.promises.open(filePath, 'r'); // FileHandle
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
        // 파일 시작까지 왔는데 더 이상 \n 없음 → 남은 버퍼 반환
        if (!this.buffer) return null;
        const last = this.buffer;
        this.buffer = '';
        return last.replace(/\r$/, '');
      }
      const readSize = Math.min(this.chunkSize, this.pos);
      const start = this.pos - readSize;
      const buf = Buffer.alloc(readSize);
      // ⬇️ FileHandle.read 사용
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

/** 타입 단위 커서: 최신 파일부터 역방향으로 라인 공급 + 타임존 보정 */
class TypeCursor {
  private readers: ReverseLineReader[] = [];
  private tzc: TimezoneCorrector;
  public seq = 0;

  private constructor(private baseDir: string, public readonly typeKey: string) {
    this.tzc = new TimezoneCorrector(typeKey);
  }

  static async create(baseDir: string, typeKey: string, files: string[]): Promise<TypeCursor> {
    const c = new TypeCursor(baseDir, typeKey);
    for (const f of files) {
      const full = path.join(baseDir, f);
      const rr = await ReverseLineReader.open(full);
      c.readers.push(rr);
    }
    return c;
  }

  async next(): Promise<{ ts: number; entry: LogEntry } | null> {
    while (this.readers.length) {
      const cur = this.readers[0];
      const line = await cur.nextLine();
      if (line !== null) {
        const sourceName = path.basename(cur.filePath || '');
        const raw = lineToEntry(sourceName || this.typeKey, line);
        const corrected = this.tzc.adjust(raw.ts);
        const entry: LogEntry = { ...raw, ts: corrected };
        this.seq++;
        // entry.source는 파일명 기준 유지
        return { ts: corrected, entry };
      }
      // 파일 소진 → 닫고 다음 파일
      await cur.close();
      log.debug?.(`cursor.next: file exhausted ${path.basename(cur.filePath)}`);
      this.readers.shift();
    }
    return null;
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
    id: Date.now(),
    ts: parseTs(line) ?? Date.now(),
    level: guessLevel(line),
    type: 'system',
    source: path.basename(filePath),
    text: line,
  };
}
