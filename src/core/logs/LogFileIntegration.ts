// === src/core/logs/LogFileIntegration.ts ===
import { createReadStream } from 'fs';
import * as readline from 'readline';
import { getLogger } from '../logging/extension-logger.js';
import type { LogEntry } from '../../extension/messaging/messageTypes.js';

const log = getLogger('LogFileIntegration');

export type MergeOptions = {
  dir: string;
  reverse?: boolean;
  signal?: AbortSignal;
  onBatch: (logs: LogEntry[]) => void;
  batchSize?: number;
};

export async function mergeDirectory(opts: MergeOptions) {
  // P1 스텁: 단일 파일/간단 라인 파서로도 충분 (여기서는 형식 미가정)
  // TODO: 파일 스캔 → 타임스탬프 파싱 → 정렬 → 배치 방출
  log.info(`[stub] mergeDirectory dir=${opts.dir}`);
  const dummy: LogEntry = {
    id: Date.now(),
    ts: Date.now(),
    level: 'I',
    type: 'system',
    source: 'stub-merge',
    text: `merged snapshot at ${new Date().toISOString()}`,
  };
  opts.onBatch([dummy]);
}

// (참고용) 라인 리더 예시
export async function readLines(path: string, onLine: (s: string) => void, signal?: AbortSignal) {
  const rs = createReadStream(path, 'utf8');
  const rl = readline.createInterface({ input: rs });
  const onAbort = () => rs.close();
  signal?.addEventListener('abort', onAbort);
  for await (const line of rl) onLine(line);
  signal?.removeEventListener('abort', onAbort);
}
