// === src/core/logs/__tests__/LogFileIntegration.test.ts ===
import * as fs from 'fs';
import * as path from 'path';
import type { LogEntry } from '@ipc/messages';
import { mergeDirectory, countTotalLinesInDir } from '../LogFileIntegration.js';

// 전역 타임아웃(파일 상단, describe 밖)
jest.setTimeout(600_000); // 10분

// 테스트 산출물/중간물을 모두 모을 고정 디렉터리
const OUT_ROOT = path.join(__dirname, 'out');

function cleanOutDir() {
  // 매 테스트 시작 전에 out 폴더를 깔끔하게 비움
  try { fs.rmSync(OUT_ROOT, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(OUT_ROOT, { recursive: true });
}

async function drainNextTicks() {
  // 즉시 예약/타이머 큐를 한 번씩 비워 늦은 로그/flush 소진
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

async function runMergeTest(testName: string, testSuiteDir: string, outputFileName: string) {
  const testDir = path.resolve(__dirname, 'test_log', testSuiteDir);
  const inputDir = path.join(testDir, 'before_merge');
  const expectedOutputPath = path.join(testDir, 'after_merge', 'merged.log');

  // 기대 결과 읽기 (raw 텍스트 라인들)
  const expectedContent = fs.readFileSync(expectedOutputPath, 'utf8');
  const expectedLines = expectedContent
    .trim()
    .split('\n')
    .map(line => line.replace(/\r$/, ''))
    .filter(line => line.length > 0);

  console.log(`📊 ${testName} - Expected lines: ${expectedLines.length}, first line: "${expectedLines[0]}"`);

  // out/merged 디렉터리 준비
  const outDir = OUT_ROOT;
  const mergedDir = path.join(outDir, 'merged');
  fs.mkdirSync(mergedDir, { recursive: true });

  // 실제 병합 결과 수집 및 파일 저장
  const actualResults: LogEntry[] = [];
  const outputPath = path.join(outDir, outputFileName);
  const outputStream = fs.createWriteStream(outputPath, { encoding: 'utf8' });

  const onBatch = (logs: LogEntry[]) => {
    actualResults.push(...logs);
    // 파일로도 저장
    for (const log of logs) {
      outputStream.write(log.text + '\n');
    }
  };

  // 병합 실행 (JSONL은 ts 내림차순=최신→오래된으로 저장, 읽기는 순방향)
  await mergeDirectory({
    dir: inputDir,
    mergedDirPath: mergedDir,
    onBatch,
    batchSize: 1000,
  });

  // 내부 비동기(즉시 예약/타이머) 소진
  await drainNextTicks();

  // 파일 스트림 닫기 (finish 보장)
  await new Promise<void>((resolve) => {
    outputStream.end(() => resolve());
  });

  // 결과 검증: 라인 수
  expect(actualResults.length).toBe(expectedLines.length);

  // 텍스트 비교 (상위 20건까지만 mismatch 표출)
  const actualTexts = actualResults.map(entry => entry.text);
  const mismatches: string[] = [];
  for (let i = 0; i < expectedLines.length; i++) {
    if (actualTexts[i] !== expectedLines[i]) {
      mismatches.push(
        `Line ${i + 1}:\n  Expected: "${expectedLines[i]}"\n  Actual:   "${actualTexts[i]}"`
      );
      if (mismatches.length >= 20) break;
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Test failed with ${mismatches.length} line mismatches\n` + mismatches.join('\n'));
  }

  console.log(`✅ ${testName} passed: ${actualResults.length} lines merged correctly`);

  // ⛔️ out은 남겨둠: 요청사항에 따라 산출물 확인 가능해야 함
}

describe('LogFileIntegration', () => {
  // 모든 테스트는 시작 전에 out 폴더 삭제 후 재생성
  beforeEach(() => {
    cleanOutDir();
  });

  describe('mergeDirectory 함수', () => {
    it('일반 로그 파일들을 정확히 병합해야 함', async () => {
      await runMergeTest('Normal test', 'normal_test_suite', 'normal_result_merged.log');
    }, 600_000); // 10분

    it('타임존 점프가 있는 로그 파일들을 정확히 병합해야 함', async () => {
      await runMergeTest('Timezone test', 'timezone_jump_test_suite', 'timezone_result_merged.log');
    }, 600_000); // 10분

    it('빈 디렉터리를 gracefully 처리해야 함', async () => {
  // out/temp_empty 를 사용
  const tempDir = path.join(OUT_ROOT, 'temp_empty');
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(tempDir, { recursive: true });

  // ⬇️ out/merged 를 항상 테스트 중간물 위치로 사용
  const mergedDir = path.join(OUT_ROOT, 'merged');
  fs.mkdirSync(mergedDir, { recursive: true });

  const onBatch = jest.fn((logs: LogEntry[]) => {
    // 호출되면 빈 배열이어야 함
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.length).toBe(0);
  });

  await mergeDirectory({
    dir: tempDir,
    onBatch,
    mergedDirPath: mergedDir,   // ✅ out/merged 고정
  });

  expect(onBatch).not.toHaveBeenCalled(); // 이상적: 아예 호출되지 않음
}, 60_000);

it('중단 신호를 제대로 처리해야 함', async () => {
  const testDir = path.resolve(__dirname, 'test_log', 'normal_test_suite');
  const inputDir = path.join(testDir, 'before_merge');

  // ⬇️ out/merged 를 항상 테스트 중간물 위치로 사용
  const mergedDir = path.join(OUT_ROOT, 'merged');
  fs.mkdirSync(mergedDir, { recursive: true });

  const abortController = new AbortController();
  let batchCount = 0;               // Abort 전까지 onBatch 호출 횟수
  let abortedAt: number | null = null; // Abort 트리거된 배치 번호
  let postAbortBatches = 0;         // Abort 이후 onBatch 호출 횟수(0이어야 함)
  let emittedLines = 0;             // 내보낸 총 라인수(전체보다 작아야 함)

  const onBatch = (logs: LogEntry[]) => {
    // Abort 이후에는 더 이상 방출되면 안 됨
    if (abortedAt !== null) {
      postAbortBatches++;
      return;
    }
    batchCount++;
    emittedLines += logs.length;
    // 세 번째 배치에서 중단 트리거
    if (batchCount >= 3 && !abortController.signal.aborted) {
      abortedAt = batchCount;
      abortController.abort();
    }
  };

  // Abort 시 예외 없이 resolve 되어야 함
  await expect(
    mergeDirectory({
      dir: inputDir,
      onBatch,
      signal: abortController.signal,
      batchSize: 1,              // 매우 작은 배치로 여러 번 호출되게 함
      mergedDirPath: mergedDir,  // ✅ out/merged 고정
    })
  ).resolves.toBeUndefined();

  // ✅ 정말로 Abort가 트리거되었는지
  expect(abortedAt).not.toBeNull();
  // ✅ Abort 이후 추가 onBatch 호출이 전혀 없었는지
  expect(postAbortBatches).toBe(0);
  // ✅ Abort 시점 이후 batchCount가 증가하지 않았는지
  expect(batchCount).toBe(abortedAt);
  // ✅ 전체 라인 수보다 적게 방출되었는지(중간에서 끊겼음을 간접 검증)
  const { total } = await countTotalLinesInDir(inputDir);
  expect(emittedLines).toBeLessThan(total);
}, 60_000);
  });
});
