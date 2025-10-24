import { __setWarmupFlagsForTests } from '../shared/featureFlags.js';
import type { LogEntry } from '../shared/ipc/messages.js';
import { mergeDirectory } from '../core/logs/LogFileIntegration.js';
import { cleanDir, prepareUniqueOutDir, setupTempInput } from './helpers/testFs.js';
import { measureBlock } from '../core/logging/perf.js';

jest.setTimeout(120_000);

let FIX: string;

describe('Log merge warmup mode wiring', () => {
  beforeEach(() => {
    FIX = prepareUniqueOutDir('tmp-merge-mode');
    __setWarmupFlagsForTests({ writeRaw: false });
    return setupTempInput(FIX, { cpcd: 120, kernel: 120 });
  });
  afterEach(() => {
    cleanDir(FIX);
  });

  it('kway mode (warmup=false) runs without errors', async () => {
    const batches: number[] = [];
    await measureBlock('merge-mode-kway', () =>
      mergeDirectory({
        dir: FIX,
        onBatch: (logs: LogEntry[]) => batches.push(logs.length),
        warmup: false,
        warmupPerTypeLimit: 0,
        batchSize: 500,
      })
    );
    expect(batches.length).toBeGreaterThan(0);
  });

  it('warmup mode (warmup=true) is accepted (no crash) and still emits batches', async () => {
    const batches: number[] = [];
    await measureBlock('merge-mode-warmup', () =>
      mergeDirectory({
        dir: FIX,
        onBatch: (logs: LogEntry[]) => batches.push(logs.length),
        warmup: true,
        warmupPerTypeLimit: 500,
        batchSize: 500,
      })
    );
    expect(batches.length).toBeGreaterThan(0);
  });
});