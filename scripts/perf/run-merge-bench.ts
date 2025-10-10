/**
 * ============================================================
 * Homey EdgeTool - 성능 검증 스크립트 (run-merge-bench.ts)
 * ============================================================
 *
 * ## 테스트 방법
 * ```bash
 * npm run perf:merge --dir "D:\logs\homey" --runs 5 --warmup 1 --batch 500
 * ```
 *
 * ## 옵션 설명
 * - `--dir`     : **필수**. 실제 로그가 들어있는 루트 폴더
 * - `--runs`    : 측정 반복 횟수 (기본값: 3)
 * - `--warmup`  : 워밍업 횟수 (기본값: 1) — JIT/디스크 캐시 예열용
 * - `--batch`   : `mergeDirectory`의 배치 크기 힌트 (기본값: 500)
 * - `--reverse` : 필요 시 역순 처리 (기본값: false)
 *
 * ## 목적
 * - 파일 병합 모드(LogFileIntegration.mergeDirectory)의 **순수 성능 검증**
 * - UI(Webview)와 무관하게 I/O + 파싱 + 배치 처리 경로만 측정
 * - 워밍업 후 N회 반복 측정하여 평균/편차 확인
 *
 * ============================================================
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

import { mergeDirectory } from '../../core/logs/LogFileIntegration.js';
import type { LogEntry } from '../../extension/messaging/messageTypes.js';

// ────────────────────────────────────────────────────────────
// 간단한 인자 파서
function getArg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) {
    const v = process.argv[i + 1];
    if (!v || v.startsWith('--')) return 'true';
    return v;
  }
  return def;
}
function getInt(name: string, def: number) {
  const v = getArg(name);
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}
function getBool(name: string, def = false) {
  const v = getArg(name);
  if (v === undefined) return def;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return Boolean(v);
}
// ────────────────────────────────────────────────────────────

type RunConfig = {
  dir: string;
  runs: number;
  warmup: number;
  batchSize?: number;
  reverse?: boolean;
};

type RunStats = {
  ms: number;
  cpuUserMs: number;
  cpuSysMs: number;
  rssDeltaMB: number;
  heapDeltaMB: number;
  entries: number;
  batches: number;
  chars: number;
  throughputEPS: number; // entries / sec
};

function mb(n: number) {
  return Math.round((n / (1024 * 1024)) * 100) / 100;
}

async function runOnce(cfg: RunConfig): Promise<RunStats> {
  // GC 노이즈 최소화 (node --expose-gc 로 실행 권장)

  const g: any = globalThis as any;
  if (typeof g.gc === 'function') g.gc();

  const mem0 = process.memoryUsage();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();

  let entries = 0;
  let batches = 0;
  let chars = 0;

  await mergeDirectory({
    dir: cfg.dir,
    reverse: cfg.reverse,
    batchSize: cfg.batchSize,
    onBatch: (logs: LogEntry[]) => {
      batches++;
      entries += logs.length;
      // 처리 텍스트 총량(대략적인 I/O 비용 추정용)
      for (const l of logs) chars += (l.text?.length || 0) + 1;
    },
  });

  const ms = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const mem1 = process.memoryUsage();

  const rssDeltaMB = mb(mem1.rss - mem0.rss);
  const heapDeltaMB = mb(mem1.heapUsed - mem0.heapUsed);

  const throughputEPS = ms > 0 ? Math.round((entries / (ms / 1000)) * 100) / 100 : 0;

  return {
    ms: Math.round(ms),
    cpuUserMs: Math.round(cpu.user / 1000),
    cpuSysMs: Math.round(cpu.system / 1000),
    rssDeltaMB,
    heapDeltaMB,
    entries,
    batches,
    chars,
    throughputEPS,
  };
}

function summarize(all: RunStats[]) {
  const avg = <K extends keyof RunStats>(k: K) =>
    Math.round((all.reduce((s, r) => s + (r[k] as number), 0) / all.length) * 100) / 100;

  return {
    samples: all.length,
    avgMs: avg('ms'),
    avgEPS: avg('throughputEPS'),
    avgCPUUserMs: avg('cpuUserMs'),
    avgCPUSysMs: avg('cpuSysMs'),
    avgRssDeltaMB: avg('rssDeltaMB'),
    avgHeapDeltaMB: avg('heapDeltaMB'),
    totalEntries: all.reduce((s, r) => s + r.entries, 0),
    totalBatches: all.reduce((s, r) => s + r.batches, 0),
  };
}

async function main() {
  const dir = getArg('dir') || '';
  const runs = getInt('runs', 3);
  const warmup = getInt('warmup', 1);
  const batchSize = getInt('batch', 500);
  const reverse = getBool('reverse', false);

  if (!dir) {
    console.error('❌ --dir <log_directory> 가 필요합니다.');
    process.exit(2);
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`❌ 디렉토리를 찾을 수 없음: ${dir}`);
    process.exit(2);
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' Homey Log Merge Benchmark');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`dir       : ${dir}`);
  console.log(`runs      : ${runs}`);
  console.log(`warmup    : ${warmup}`);
  console.log(`batchSize : ${batchSize}`);
  console.log(`reverse   : ${reverse}`);

  const g: any = globalThis as any;
  console.log(`gc available: ${typeof g.gc === 'function' ? 'yes (--expose-gc)' : 'no'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Warmup
  for (let i = 0; i < warmup; i++) {
    await runOnce({ dir, runs, warmup, batchSize, reverse });
  }

  // Measured runs
  const results: RunStats[] = [];
  for (let i = 0; i < runs; i++) {
    const r = await runOnce({ dir, runs, warmup, batchSize, reverse });
    results.push(r);
    console.log(
      `#${i + 1}: ${r.ms} ms | ${r.throughputEPS} eps | cpu u/s: ${r.cpuUserMs}/${r.cpuSysMs} ms | rssΔ: ${r.rssDeltaMB} MB | heapΔ: ${r.heapDeltaMB} MB | entries: ${r.entries} | batches: ${r.batches}`,
    );
  }

  const sum = summarize(results);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(
    `Avg: ${sum.avgMs} ms, ${sum.avgEPS} eps, CPU u/s ${sum.avgCPUUserMs}/${sum.avgCPUSysMs} ms, RSSΔ ${sum.avgRssDeltaMB} MB, HeapΔ ${sum.avgHeapDeltaMB} MB`,
  );
  console.log(`Total entries: ${sum.totalEntries}, batches: ${sum.totalBatches}`);

  // 결과 파일 기록
  const outDir = path.join('dist', 'perf');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `merge_${Date.now()}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { cfg: { dir, runs, warmup, batchSize, reverse }, results, summary: sum },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`✔ 결과 저장: ${outPath}`);
}

main().catch((e) => {
  console.error('Benchmark failed:', e?.stack || e?.message || String(e));
  process.exit(1);
});
