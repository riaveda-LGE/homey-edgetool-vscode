import { __setWarmupFlagsForTests } from '../shared/featureFlags.js';
import { FIRST_BATCH_SIZE } from '../shared/const.js';
import type { LogEntry } from '../shared/ipc/messages.js';
import { LogSessionManager } from '../core/sessions/LogSessionManager.js';
import { cleanDir, prepareUniqueOutDir, setupTempInput } from './helpers/testFs.js';
import { measureBlock } from '../core/logging/perf.js';

jest.setTimeout(600_000);

let INPUT_DIR: string;

beforeEach(() => {
  INPUT_DIR = prepareUniqueOutDir('ab-compare');
  return setupTempInput(INPUT_DIR, {
    cpcd: 2000,
    'homey-pro': 2000,
    kernel: 2000,
    matter: 2000,
    z3gateway: 2000,
  });
});

afterEach(() => {
  cleanDir(INPUT_DIR);
});

async function runOnce(
  useWarmup: boolean,
  limit = 10000,
): Promise<{ initialMs: number; firstLen: number; total?: number }> {
  __setWarmupFlagsForTests({
    warmupEnabled: useWarmup,
    warmupPerTypeLimit: limit,
    warmupTarget: 2000,
    writeRaw: false,
  });

  const mgr = new LogSessionManager(undefined);
  const t0 = Date.now();
  let firstLen = 0;
  let initialMs = 0;
  let finalTotal: number | undefined;

  await measureBlock(`start-file-merge-session-${useWarmup ? 'warmup' : 'full'}`, () =>
    mgr.startFileMergeSession({
      dir: INPUT_DIR,
      onBatch: (logs: LogEntry[], _total?: number, seq?: number) => {
        if (seq === 1) {
          firstLen = logs.length;
          initialMs = Date.now() - t0;
        }
      },
      onSaved: (info: { outDir: string; manifestPath: string; chunkCount: number; total?: number; merged: number }) => {
        finalTotal = info.total ?? info.merged;
      },
      onProgress: () => {},
    } as any)
  );

  return { initialMs, firstLen, total: finalTotal };
}

describe('Warmup vs Full merge', () => {
  it('초기 배치 시간/크기 비교', async () => {
    const full = await runOnce(false, 0);
    const warm = await runOnce(true, 500);

    const diffMs = (full.initialMs ?? 0) - (warm.initialMs ?? 0);
    const pct = full.initialMs > 0 ? Math.round((diffMs / full.initialMs) * 100) : 0;

    console.log('\n[WarmupVsFull]');
    console.log(
      `  First batch latency  |  OFF: ${full.initialMs} ms (n=${full.firstLen})  ` +
        `ON: ${warm.initialMs} ms (n=${warm.firstLen})  Δ: ${diffMs} ms (~${pct}%)`,
    );
    console.log(`  Final merged totals  |  OFF: ${full.total}  ON: ${warm.total}\n`);

    expect(full.firstLen).toBe(FIRST_BATCH_SIZE);
    expect(warm.firstLen).toBe(FIRST_BATCH_SIZE);
    expect(warm.initialMs).toBeLessThan(full.initialMs);
    expect(full.total).toBe(2000 * 5);
    expect(warm.total).toBe(2000 * 5);
  });
});