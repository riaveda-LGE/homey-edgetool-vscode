import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import type { LogEntry } from '../../extension/messaging/messageTypes.js';
import { getLogger } from '../logging/extension-logger.js';
import { measureIO } from '../logging/perf.js';
import { XError, ErrorCategory } from '../../shared/errors.js';
import { DEFAULT_BATCH_SIZE } from '../../shared/const.js';

const log = getLogger('LogFileIntegration');

export type MergeOptions = {
  dir: string;
  reverse?: boolean; // 기본: 오래된→최신. false면 최신→오래된 순으로 파일 순회
  signal?: AbortSignal;
  onBatch: (logs: LogEntry[]) => void;
  batchSize?: number; // 기본 200
};

export async function mergeDirectory(opts: MergeOptions) {
  try {
    const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
    const files = await listLogFiles(opts.dir);
    const ordered = opts.reverse ? files : files.sort(compareLogOrderDesc); // 최신부터

    log.info(`mergeDirectory: ${ordered.length} files`);

    for (const f of ordered) {
      await streamFile(
        path.join(opts.dir, f),
        (entries) => opts.onBatch(entries),
        batchSize,
        opts.signal,
      );
      if (opts.signal?.aborted) break;
    }
  } catch (e) {
    throw new XError(ErrorCategory.Path, `Failed to merge log directory ${opts.dir}: ${e instanceof Error ? e.message : String(e)}`, e);
  }
}

function compareLogOrderDesc(a: string, b: string) {
  // homey-pro.log > .log.1 > .log.2 …
  const na = numberSuffix(a);
  const nb = numberSuffix(b);
  // 숫자가 작을수록 최신
  return na - nb;
}

function numberSuffix(name: string) {
  const m = name.match(/\.log(?:\.(\d+))?$/);
  if (!m) return 9999;
  return m[1] ? parseInt(m[1], 10) : -1;
}

async function listLogFiles(dir: string): Promise<string[]> {
  try {
    const all = await fs.promises.readdir(dir);
    return all.filter((f) => /\.log(\.\d+)?$/.test(f));
  } catch (e) {
    throw new XError(ErrorCategory.Path, `Failed to list log files in ${dir}: ${e instanceof Error ? e.message : String(e)}`, e);
  }
}

async function streamFile(
  filePath: string,
  emit: (batch: LogEntry[]) => void,
  batchSize: number,
  signal?: AbortSignal,
) {
  try {
    const rs = fs.createReadStream(filePath, 'utf8');
    const rl = readline.createInterface({ input: rs });
    const batch: LogEntry[] = [];
    const onAbort = () => rs.close();
    signal?.addEventListener('abort', onAbort);

    for await (const line of rl) {
      const e: LogEntry = {
        id: Date.now(),
        ts: parseTs(line) ?? Date.now(),
        level: guessLevel(line),
        type: 'system',
        source: path.basename(filePath),
        text: line,
      };
      batch.push(e);
      if (batch.length >= batchSize) {
        emit(batch.splice(0, batch.length));
      }
      if (signal?.aborted) break;
    }
    if (batch.length) emit(batch);
    signal?.removeEventListener('abort', onAbort);
  } catch (e) {
    log.warn(`streamFile error ${filePath}: ${String(e)}`);
    throw new XError(ErrorCategory.Path, `Failed to stream log file ${filePath}: ${e instanceof Error ? e.message : String(e)}`, e);
  }
}

function parseTs(line: string): number | undefined {
  // ISO-like 먼저
  const iso = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/);
  if (iso) {
    const t = Date.parse(iso[0]);
    if (!Number.isNaN(t)) return t;
  }
  // "MM-DD HH:MM:SS.mmm" 같은 logcat 포맷(연도는 올해로 가정)
  const md = line.match(/(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (md) {
    const now = new Date();
    const d = new Date(
      now.getFullYear(),
      parseInt(md[1], 10) - 1,
      parseInt(md[2], 10),
      parseInt(md[3], 10),
      parseInt(md[4], 10),
      parseInt(md[5], 10),
      md[6] ? parseInt(md[6].slice(0, 3).padEnd(3, '0'), 10) : 0,
    );
    return d.getTime();
  }
  return undefined;
}

function guessLevel(line: string): 'D' | 'I' | 'W' | 'E' {
  if (/\b(error|err|fail|fatal)\b/i.test(line)) return 'E';
  if (/\bwarn(ing)?\b/i.test(line)) return 'W';
  if (/\bdebug|trace\b/i.test(line)) return 'D';
  return 'I';
}
