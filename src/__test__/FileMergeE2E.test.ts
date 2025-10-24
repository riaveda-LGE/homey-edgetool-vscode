import * as fs from 'fs';
import * as path from 'path';
import type { LogEntry, MergeSavedInfo } from '../shared/ipc/messages.js';
import { LogSessionManager } from '../core/sessions/LogSessionManager.js';
import { __setWarmupFlagsForTests } from '../shared/featureFlags.js';
import {
  prepareUniqueOutDir,
  cleanDir,
  setupTempInput,
  cleanOutputs,
} from './helpers/testFs.js';
import { measureBlock } from '../core/logging/perf.js';

jest.setTimeout(600_000);

let DIR: string;
beforeEach(async () => {
  DIR = prepareUniqueOutDir('e2e');
  await setupTempInput(DIR, { alpha: 250, beta: 120, gamma: 60 });
  // 가벼운 웜업(테스트 시간 단축)
  __setWarmupFlagsForTests({ warmupEnabled: true, warmupTarget: 200, warmupPerTypeLimit: 200, writeRaw: false });
  cleanOutputs(DIR);
});
afterEach(() => cleanDir(DIR));

it('파일 병합 세션 E2E: manifest/chunk/콜백 일관성 검증', async () => {
  const mgr = new LogSessionManager(undefined as any);
  const batches: Array<{ n: number; seq?: number; total?: number }> = [];
  let saved: MergeSavedInfo | null = null;

  await measureBlock('file-merge-e2e-session', () =>
    mgr.startFileMergeSession({
      dir: DIR,
      onBatch: (logs: LogEntry[], total?: number, seq?: number) => {
        batches.push({ n: logs.length, total, seq });
      },
      onSaved: (info: MergeSavedInfo) => {
        saved = info;
      },
      onProgress: () => {},
    } as any)
  );

  expect(saved).toBeTruthy();
  expect(saved!.outDir).toBeTruthy();
  expect(saved!.manifestPath).toBeTruthy();
  expect(saved!.chunkCount).toBeGreaterThan(0);
  expect(saved!.merged).toBeGreaterThan(0);
  expect(fs.existsSync(saved!.manifestPath)).toBe(true);

  const manifest = JSON.parse(fs.readFileSync(saved!.manifestPath, 'utf8'));
  expect(manifest).toHaveProperty('chunks');
  expect(manifest).toHaveProperty('totalLines');
  expect(manifest.mergedLines).toBeGreaterThan(0);
  // 총 라인수는 입력 합계와 동일해야 함
  expect(manifest.totalLines).toBe(250 + 120 + 60);

  // 배치 seq는 단조 증가(또는 동일)해야 함
  const seqs = batches.map((b) => b.seq!).filter(Boolean);
  for (let i = 1; i < seqs.length; i++) {
    expect(seqs[i]!).toBeGreaterThanOrEqual(seqs[i - 1]!);
  }
});