import * as fs from 'fs';
import * as path from 'path';
import { __testOnly } from '../core/logs/LogFileIntegration.js';
import { prepareUniqueOutDir, cleanDir, cleanAndEnsureDir } from './helpers/testFs.js';

jest.setTimeout(120_000);

let DIR: string;

beforeEach(() => {
  DIR = prepareUniqueOutDir('legacy-jsonl');
  cleanAndEnsureDir(DIR);
});

afterEach(() => {
  cleanDir(DIR);
});

it('JSONL 레거시 레코드(file 누락)도 path/source로 file을 보강한다', async () => {
  const mergedDir = path.join(DIR, 'merged');
  fs.mkdirSync(mergedDir, { recursive: true });

  // file 없음 + source로만 식별
  const a = path.join(mergedDir, 'kernel.jsonl');
  fs.writeFileSync(
    a,
    JSON.stringify({ ts: 1, text: 'a', source: 'kernel.log' }) + '\n',
    'utf8',
  );

  // file 없음 + path로만 식별
  const b = path.join(mergedDir, 'misc.jsonl');
  fs.writeFileSync(
    b,
    JSON.stringify({ ts: 2, text: 'b', path: '/tmp/x/cpcd.log' }) + '\n',
    'utf8',
  );

  const files = await __testOnly.listMergedJsonlFiles(mergedDir);
  expect(files.sort()).toEqual(['kernel.jsonl', 'misc.jsonl']);

  const curA = await __testOnly.MergedCursor.create(a, 'kernel');
  const curB = await __testOnly.MergedCursor.create(b, 'misc');

  const batchA = await curA.nextBatch(10);
  const batchB = await curB.nextBatch(10);

  expect(batchA.length).toBe(1);
  expect(batchB.length).toBe(1);
  expect(batchA[0].entry.file).toBe('kernel.log');
  expect(batchB[0].entry.file).toBe('cpcd.log');
});
