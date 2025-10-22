import type { LogEntry } from '../shared/ipc/messages.js';
import { mergeDirectory } from '../core/logs/LogFileIntegration.js';
import { prepareUniqueOutDir, cleanDir, setupTempInput } from './helpers/testFs.js';

jest.setTimeout(120_000);

let DIR: string;
beforeEach(async () => {
  DIR = prepareUniqueOutDir('reverse');
  await setupTempInput(DIR, { alpha: 5, beta: 5 });
});
afterEach(() => cleanDir(DIR));

it('reverse=true 에서 오래된→최신 순으로 비감소(ts) 순서를 유지한다', async () => {
  const all: LogEntry[] = [];
  await mergeDirectory({
    dir: DIR,
    reverse: true,
    batchSize: 3,
    onBatch: (logs) => all.push(...logs),
  });
  expect(all.length).toBe(10);
  for (let i = 1; i < all.length; i++) {
    expect(all[i].ts).toBeGreaterThanOrEqual(all[i - 1].ts);
  }
  // file 필드는 항상 basename이어야 함(경로 구분자 포함 금지)
  expect(all.every((e) => typeof e.file === 'string' && !e.file!.includes('/'))).toBe(true);
});
