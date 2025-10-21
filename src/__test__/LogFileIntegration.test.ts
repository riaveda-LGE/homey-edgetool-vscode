// === src/__test__/LogFileIntegration.test.ts ===
import type { LogEntry } from '@ipc/messages';
import * as fs from 'fs';
import * as path from 'path';

import { countTotalLinesInDir, mergeDirectory } from '../core/logs/LogFileIntegration.js';
import {
  cleanAndEnsureDir,
  cleanDir,
  drainNextTicks,
  prepareUniqueOutDir,
} from './helpers/testFs.js';

jest.setTimeout(600_000);

let OUT_DIR: string;

async function runMergeTest(testName: string, testSuiteDir: string, outputFileName: string) {
  const testDir = path.resolve(__dirname, 'test_log', testSuiteDir);
  const inputDir = path.join(testDir, 'before_merge');
  const expectedOutputPath = path.join(testDir, 'after_merge', 'merged.log');

  const expectedContent = fs.readFileSync(expectedOutputPath, 'utf8');
  const expectedLines = expectedContent
    .trim()
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);

  console.log(
    `📊 ${testName} - Expected lines: ${expectedLines.length}, first line: "${expectedLines[0]}"`,
  );

  const outDir = OUT_DIR;
  const mergedDir = path.join(OUT_DIR, 'merged');
  fs.mkdirSync(mergedDir, { recursive: true });

  const actualResults: LogEntry[] = [];
  const outputPath = path.join(OUT_DIR, outputFileName);
  const outputStream = fs.createWriteStream(outputPath, { encoding: 'utf8' });

  const onBatch = (logs: LogEntry[]) => {
    actualResults.push(...logs);
    for (const log of logs) outputStream.write(log.text + '\n');
  };

  await mergeDirectory({
    dir: inputDir,
    mergedDirPath: mergedDir,
    onBatch,
    batchSize: 1000,
  });

  await drainNextTicks();
  await new Promise<void>((resolve) => { outputStream.end(() => resolve()); });

  expect(actualResults.length).toBe(expectedLines.length);

  const actualTexts = actualResults.map((entry) => entry.text);
  const mismatches: string[] = [];
  for (let i = 0; i < expectedLines.length; i++) {
    if (actualTexts[i] !== expectedLines[i]) {
      mismatches.push(
        `Line ${i + 1}:\n  Expected: "${expectedLines[i]}"\n  Actual:   "${actualTexts[i]}"`,
      );
      if (mismatches.length >= 20) break;
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Test failed with ${mismatches.length} line mismatches\n` + mismatches.join('\n'));
  }

  console.log(`✅ ${testName} passed: ${actualResults.length} lines merged correctly`);
}

describe('LogFileIntegration', () => {
  beforeEach(() => {
    OUT_DIR = prepareUniqueOutDir('lfi');
    cleanAndEnsureDir(OUT_DIR);
  });
  afterEach(() => {
    cleanDir(OUT_DIR);
  });

  describe('mergeDirectory 함수', () => {
    it('일반 로그 파일들을 정확히 병합해야 함', async () => {
      await runMergeTest('Normal test', 'normal_test_suite', 'normal_result_merged.log');
    }, 600_000);

    it('타임존 점프가 있는 로그 파일들을 정확히 병합해야 함', async () => {
      await runMergeTest('Timezone test', 'timezone_jump_test_suite', 'timezone_result_merged.log');
    }, 600_000);

    it('빈 디렉터리를 gracefully 처리해야 함', async () => {
      const tempDir = path.join(OUT_DIR, 'temp_empty');
      cleanAndEnsureDir(tempDir);

      const mergedDir = path.join(OUT_DIR, 'merged');
      cleanAndEnsureDir(mergedDir);

      const onBatch = jest.fn((logs: LogEntry[]) => {
        expect(Array.isArray(logs)).toBe(true);
        expect(logs.length).toBe(0);
      });

      await mergeDirectory({ dir: tempDir, onBatch, mergedDirPath: mergedDir });

      expect(onBatch).not.toHaveBeenCalled();
    }, 60_000);

    it('중단 신호를 제대로 처리해야 함', async () => {
      const testDir = path.resolve(__dirname, 'test_log', 'normal_test_suite');
      const inputDir = path.join(testDir, 'before_merge');

      const mergedDir = path.join(OUT_DIR, 'merged');
      cleanAndEnsureDir(mergedDir);

      const abortController = new AbortController();
      let batchCount = 0;
      let abortedAt: number | null = null;
      let postAbortBatches = 0;
      let emittedLines = 0;

      const onBatch = (logs: LogEntry[]) => {
        if (abortedAt !== null) {
          postAbortBatches++;
          return;
        }
        batchCount++;
        emittedLines += logs.length;
        if (batchCount >= 3 && !abortController.signal.aborted) {
          abortedAt = batchCount;
          abortController.abort();
        }
      };

      await expect(
        mergeDirectory({
          dir: inputDir,
          onBatch,
          signal: abortController.signal,
          batchSize: 1,
          mergedDirPath: mergedDir,
        }),
      ).resolves.toBeUndefined();

      expect(abortedAt).not.toBeNull();
      expect(postAbortBatches).toBe(0);
      expect(batchCount).toBe(abortedAt);
      const { total } = await countTotalLinesInDir(inputDir);
      expect(emittedLines).toBeLessThan(total);
    }, 60_000);
  });
});