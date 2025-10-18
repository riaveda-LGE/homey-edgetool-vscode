import { mergeDirectory } from '../LogFileIntegration.js';
import type { LogEntry } from '../../../shared/ipc/messages.js';
import { setupTempInput, prepareUniqueOutDir, cleanDir } from './helpers/testFs.js';
import { __setWarmupFlagsForTests } from '../../../shared/featureFlags.js';

jest.setTimeout(120_000);

let FIX: string; // 매 테스트마다 out/ 아래 고유 경로 생성

describe('Log merge warmup mode wiring', () => {
  beforeEach(() => {
    // 매 테스트마다 유니크 입력 폴더 생성 후 cpcd/kernel 각각 120줄 생성
    FIX = prepareUniqueOutDir('tmp-merge-mode');
    // RAW 기록은 테스트에서 비활성화 (권한/성능 이슈 회피)
    __setWarmupFlagsForTests({ writeRaw: false });
    return setupTempInput(FIX, { cpcd: 120, kernel: 120 });
  });
  afterEach(() => {
    // 입력/산출물(merge_log 포함) 모두 FIX 하위에 생기므로, 통째로 삭제
    cleanDir(FIX);
  });

  it('kway mode (warmup=false) runs without errors', async () => {
    const batches: number[] = [];
    await mergeDirectory({
      dir: FIX,
      onBatch: (logs: LogEntry[]) => batches.push(logs.length),
      warmup: false,
      warmupPerTypeLimit: 0,
      batchSize: 500,
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
      batchSize: 500,
    });
    expect(batches.length).toBeGreaterThan(0);
  });
});
