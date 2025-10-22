import * as fs from 'fs';
import * as path from 'path';
import type { LogEntry } from '../shared/ipc/messages.js';
import { countTotalLinesInDir, mergeDirectory } from '../core/logs/LogFileIntegration.js';
import { prepareUniqueOutDir, ensureDir, cleanDir } from './helpers/testFs.js';

jest.setTimeout(120_000);

let DIR: string;
beforeEach(() => {
  DIR = prepareUniqueOutDir('lf-end');
  ensureDir(DIR);
});
afterEach(() => cleanDir(DIR));

it('EOF 개행이 없어도 마지막 라인이 카운트/방출된다', async () => {
  const fp = path.join(DIR, 'foo.log');
  // 마지막 줄에 개행이 없음
  fs.writeFileSync(
    fp,
    '2024-01-01T00:00:00.000Z foo L1\n2024-01-01T00:00:01.000Z foo L2',
    'utf8',
  );

  const { total } = await countTotalLinesInDir(DIR);
  expect(total).toBe(2);

  const got: LogEntry[] = [];
  await mergeDirectory({
    dir: DIR,
    onBatch: (logs) => got.push(...logs),
    batchSize: 10,
  });
  expect(got.length).toBe(2);
  const texts = got.map((e) => e.text);
  expect(texts).toContain('2024-01-01T00:00:01.000Z foo L2');
});
