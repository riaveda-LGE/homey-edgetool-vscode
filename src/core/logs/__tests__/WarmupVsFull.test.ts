import { __setWarmupFlagsForTests } from '../../../shared/featureFlags.js';
import type { LogEntry } from '../../../shared/ipc/messages.js';
import { LogSessionManager } from '../../sessions/LogSessionManager.js';
import { cleanDir, prepareUniqueOutDir, setupTempInput } from './helpers/testFs.js';

jest.setTimeout(600_000);

let INPUT_DIR: string; // 매 테스트마다 out/ 아래 고유 경로 생성

beforeEach(() => {
  // 테스트 시작 시 항상 초기화: 입력 로그 생성 (유니크 입력 폴더 사용 → 충돌/락 회피)
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
  // 입력과 merge_log 산출물이 모두 INPUT_DIR 하위에 생성되므로, 통째로 제거
  cleanDir(INPUT_DIR);
});

async function runOnce(
  useWarmup: boolean,
  limit = 10000,
): Promise<{ initialMs: number; firstLen: number; total?: number }> {
  // 테스트에서 RAW 기록은 항상 OFF (네트워크 드라이브/권한 이슈 회피)
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

  await mgr.startFileMergeSession({
    dir: INPUT_DIR,
    onBatch: (logs: LogEntry[], total?: number, seq?: number) => {
      if (seq === 1) {
        firstLen = logs.length;
        initialMs = Date.now() - t0;
      }
    },
    onSaved: (info: {
      outDir: string;
      manifestPath: string;
      chunkCount: number;
      total?: number;
      merged: number;
    }) => {
      finalTotal = info.total ?? info.merged;
    },
    onProgress: () => {},
  } as any);

  return { initialMs, firstLen, total: finalTotal };
}

describe('Warmup vs Full merge', () => {
  it('초기 배치 시간/크기 비교', async () => {
    const full = await runOnce(false, 0); // 워밍업 OFF
    const warm = await runOnce(true, 500); // 워밍업 ON (limit=500, target=2000)

    // ── 사람이 읽기 쉬운 비교 출력 ────────────────────────────────────────────────
    const diffMs = (full.initialMs ?? 0) - (warm.initialMs ?? 0);
    const pct = full.initialMs > 0 ? Math.round((diffMs / full.initialMs) * 100) : 0;
    // 표 한 줄 요약
    console.log('\n[WarmupVsFull]');
    console.log(
      `  First batch latency  |  OFF: ${full.initialMs} ms (n=${full.firstLen})  ` +
        `ON: ${warm.initialMs} ms (n=${warm.firstLen})  Δ: ${diffMs} ms (~${pct}%)`,
    );
    console.log(`  Final merged totals  |  OFF: ${full.total}  ON: ${warm.total}\n`);

    // 둘 다 500줄을 첫 배치로 제공해야 함
    expect(full.firstLen).toBe(500);
    expect(warm.firstLen).toBe(500);

    // 워밍업이 초기 배치 시간을 단축해야 함(느슨한 기준)
    expect(warm.initialMs).toBeLessThan(full.initialMs);

    // 최종 총합(정밀 병합 결과)은 동일해야 함(타입×2000)
    expect(full.total).toBe(2000 * 5);
    expect(warm.total).toBe(2000 * 5);
  });
});
