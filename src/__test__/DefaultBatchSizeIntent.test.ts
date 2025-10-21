// === src/__test__/DefaultBatchSizeIntent.test.ts ===
import { __setWarmupFlagsForTests } from '../shared/featureFlags.js';
import { DEFAULT_BATCH_SIZE } from '../shared/const.js';
import type { LogEntry } from '../shared/ipc/messages.js';
import { mergeDirectory } from '../core/logs/LogFileIntegration.js';
import { cleanDir, prepareUniqueOutDir, setupTempInput } from './helpers/testFs.js';

jest.setTimeout(120_000);

let FIX: string;

beforeEach(async () => {
  FIX = prepareUniqueOutDir('default-batch');
  // 타입 1개에 450라인 정도 만들어서 200/200/50 형태로 나뉘는지 확인
  await setupTempInput(FIX, { kernel: 450 });
});

afterEach(() => {
  cleanDir(FIX);
});

it('DEFAULT_BATCH_SIZE(200)이 mergeDirectory의 기본 배치 크기로 동작한다(옵션 미지정 시)', async () => {
  const seen: number[] = [];
  await mergeDirectory({
    dir: FIX,
    // batchSize를 지정하지 않음 → DEFAULT_BATCH_SIZE가 적용되어야 함
    onBatch: (logs: LogEntry[]) => seen.push(logs.length),
  });
  // 최소 한 번은 200 단위가 등장해야 함
  expect(seen.some((n) => n === DEFAULT_BATCH_SIZE)).toBe(true);
  // 상수 자체가 200인지도 체크(의도 확인)
  expect(DEFAULT_BATCH_SIZE).toBe(200);
});

it('kway mode (warmup=false) runs without errors', async () => {
  const batches: number[] = [];
  await mergeDirectory({
    dir: FIX,
    onBatch: (logs: LogEntry[]) => batches.push(logs.length),
    warmup: false,
    warmupPerTypeLimit: 0,
    batchSize: DEFAULT_BATCH_SIZE,
  });
  expect(batches.length).toBeGreaterThan(0);
});

it('warmup mode (warmup=true) is accepted (no crash) and still emits batches', async () => {
  const batches: number[] = [];
  await mergeDirectory({
    dir: FIX,
    onBatch: (logs: LogEntry[]) => batches.push(logs.length),
    warmup: true,
    warmupPerTypeLimit: 500,
    batchSize: DEFAULT_BATCH_SIZE,
  });
  expect(batches.length).toBeGreaterThan(0);
});