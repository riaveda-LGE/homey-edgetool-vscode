// === src/core/logs/__tests__/LogFileIntegration.test.ts ===
import * as fs from 'fs';
import * as path from 'path';
import type { LogEntry } from '../../../extension/messaging/messageTypes.js';
import { mergeDirectory } from '../LogFileIntegration.js';

async function runMergeTest(testName: string, testSuiteDir: string, outputFileName: string) {
  // 타임아웃 늘리기 (병합 작업이 오래 걸릴 수 있음)
  jest.setTimeout(30000);
  const testDir = path.resolve(__dirname, 'test_log', testSuiteDir);
  const inputDir = path.join(testDir, 'before_merge');
  const expectedOutputPath = path.join(testDir, 'after_merge', 'merged.log');

  // 기대 결과 읽기 (raw 텍스트 라인들)
  const expectedContent = fs.readFileSync(expectedOutputPath, 'utf8');
  const expectedLines = expectedContent.trim().split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.length > 0);

  console.log(`📊 ${testName} - Expected lines: ${expectedLines.length}, first line: "${expectedLines[0]}"`);

  // 실제 병합 결과 수집 및 파일 저장
  const actualResults: LogEntry[] = [];
  const outputPath = path.join(__dirname, 'out', outputFileName);
  const outputStream = fs.createWriteStream(outputPath, 'utf8');

  const onBatch = (logs: LogEntry[]) => {
    actualResults.push(...logs);
    // 파일로도 저장
    for (const log of logs) {
      outputStream.write(log.text + '\n');
    }
  };

  // 병합 실행
  await mergeDirectory({
    dir: inputDir,
    onBatch,
    batchSize: 1000,
    // reverse: true, // 기본 최신순으로 테스트
  });

  // 파일 스트림 닫기 (Promise로 완전 종료 대기)
  await new Promise<void>((resolve) => {
    outputStream.end(() => resolve());
  });

  // 결과 검증: 라인 수가 일치하는지
  expect(actualResults.length).toBe(expectedLines.length);

  // 실제 병합된 텍스트들을 배열로 변환
  const actualTexts = actualResults.map(entry => entry.text);

  // 한 줄씩 순서대로 비교
  for (let i = 0; i < expectedLines.length; i++) {
    if (actualTexts[i] !== expectedLines[i]) {
      throw new Error(`Line ${i + 1} mismatch:\nExpected: "${expectedLines[i]}"\nActual: "${actualTexts[i]}"`);
    }
  }

  console.log(`✅ ${testName} passed: ${actualResults.length} lines merged correctly`);
}

describe('LogFileIntegration', () => {
  describe('mergeDirectory 함수', () => {
    it('일반 로그 파일들을 정확히 병합해야 함', async () => {
      await runMergeTest('Normal test', 'normal_test_suite', 'normal_result_merged.log');
    });

    it('타임존 점프가 있는 로그 파일들을 정확히 병합해야 함', async () => {
      await runMergeTest('Timezone test', 'timezone_jump_test_suite', 'timezone_result_merged.log');
    });

    it('빈 디렉터리를 gracefully 처리해야 함', async () => {
      const tempDir = path.join(__dirname, 'temp_empty');
      fs.mkdirSync(tempDir, { recursive: true });

      let batchCount = 0;
      const onBatch = (logs: LogEntry[]) => {
        batchCount++;
        expect(logs.length).toBe(0);
      };

      await mergeDirectory({
        dir: tempDir,
        onBatch,
      });

      expect(batchCount).toBe(0);

      // cleanup
      fs.rmdirSync(tempDir);
    });

    it('중단 신호를 제대로 처리해야 함', async () => {
      const testDir = path.resolve(__dirname, 'test_log', 'normal_test_suite');
      const inputDir = path.join(testDir, 'before_merge');

      const abortController = new AbortController();
      let batchCount = 0;
      const onBatch = (logs: LogEntry[]) => {
        batchCount++;
        if (batchCount >= 3) { // 세 번째 배치에서 중단
          abortController.abort();
        }
      };

      // abort signal이 전달되는지 확인
      try {
        await mergeDirectory({
          dir: inputDir,
          onBatch,
          signal: abortController.signal,
          batchSize: 1, // 매우 작은 배치로 여러 번 호출되게 함
        });
        // abort가 발생하지 않으면 실패
        throw new Error('Expected mergeDirectory to be aborted');
      } catch (error: any) {
        // abort로 인해 예외가 발생해야 함
        expect(error.message).toContain('aborted');
      }

      expect(batchCount).toBeGreaterThanOrEqual(3);
    });
  });
});
