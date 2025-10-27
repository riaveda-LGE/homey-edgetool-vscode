/// <reference types="jest" />
import * as fs from 'fs';
import * as path from 'path';

import { enableAutoFsIOMeasure,globalProfiler } from './src/core/logging/perf.js';
const __PERF_ON__ = process.env.PERF === '1';

// ── vscode 모듈 전역 mock ─────────────────────────────────────────────
jest.mock(
  'vscode',
  () => ({
    window: {
      createOutputChannel: jest.fn(() => ({
        appendLine: jest.fn(),
        show: jest.fn(),
      })),
      createWebviewPanel: jest.fn(),
      showOpenDialog: jest.fn(),
      showInputBox: jest.fn(),
      showQuickPick: jest.fn(),
      showInformationMessage: jest.fn(),
      showErrorMessage: jest.fn(),
    },
    commands: { executeCommand: jest.fn() },
    ViewColumn: { Beside: 'Beside' },
    Uri: { joinPath: jest.fn(), file: jest.fn() },
    workspace: {
      getConfiguration: jest.fn(() => ({ get: jest.fn(), update: jest.fn() })),
    },
  }),
  { virtual: true }
);

// ── 테스트 중에만 console.* 활성화 + CustomConsole 우회 ───────────────
// (teardown 이후 늦게 오는 로그는 무시. 허용 시에도 process.stdout/stderr로 직접 출력)
const writeStdout = (...args: any[]) => {
  try {
    const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    // 줄바꿈 보장
    (process.stdout as any).write(msg + '\n');
  } catch { /* noop */ }
};
const writeStderr = (...args: any[]) => {
  try {
    const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    (process.stderr as any).write(msg + '\n');
  } catch { /* noop */ }
};

function guarded<T extends (...a: any[]) => any>(fn: T): T {
  const wrapper = ((...args: any[]) => {
    if ((globalThis as any).__JEST_TEST_ACTIVE__) {
      return fn(...args); // 테스트 진행 중일 때만 허용
    }
    // 테스트 컨텍스트 밖(tear-down 포함)에서는 드랍
    return;
  }) as T;
  return wrapper;
}

// 원본 대신 직접 writer 사용(= Jest CustomConsole를 거치지 않음)
console.log   = guarded(writeStdout as any) as any;
console.info  = guarded(writeStdout as any) as any;
console.warn  = guarded(writeStderr as any) as any;
console.error = guarded(writeStderr as any) as any;
if ((console as any).debug) (console as any).debug = guarded(writeStdout as any);

// 각 테스트 생명주기에 맞춰 on/off
beforeAll(() => { (globalThis as any).__JEST_TEST_ACTIVE__ = true; });
afterEach(() => { (globalThis as any).__JEST_TEST_ACTIVE__ = false; });
beforeEach(() => { (globalThis as any).__JEST_TEST_ACTIVE__ = true; });
afterAll(() =>  { (globalThis as any).__JEST_TEST_ACTIVE__ = false; });

// ── PERF=1 일 때 Node 테스트 전역 성능 캡처 on/off + 요약 출력 ──────────
beforeAll(() => {
  if (!__PERF_ON__) return;
  try {
    globalProfiler.enable();
    enableAutoFsIOMeasure();
    globalProfiler.startCapture();
  } catch (e) {
    console.warn('[perf] failed to start capture:', e);
  }
});

afterAll(() => {
  if (!__PERF_ON__) return;
  let result: any;
  try {
    result = globalProfiler.stopCapture();
    const { duration, analysis } = result || ({} as any);
    const { functionSummary = {}, ioAnalysis = {}, insights = [] } = analysis || {};

    const top = Object.entries(functionSummary)
      .map(([name, s]: any) => ({
        name,
        calls: s.count,
        total: s.totalTime,
        avg: s.avgTime,
        max: s.maxTime,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 15);

    console.log('\n=== PERF (node/jest) ===');
    console.log(`duration: ${duration.toFixed(1)} ms`);
    // 요약 표
    console.table(
      top.map((r) => ({
        name: r.name,
        calls: r.calls,
        total_ms: r.total.toFixed(1),
        avg_ms: r.avg.toFixed(2),
        max_ms: r.max.toFixed(1),
      })),
    );
    // I/O 요약
    console.log('io.totalOperations =', ioAnalysis.totalOperations ?? 0);
    if (ioAnalysis.perOp) {
      const perOp = Object.entries(ioAnalysis.perOp)
        .map(([op, s]: any) => ({
          op,
          count: s.count,
          avg_ms: Number.isFinite(s.avgDuration) ? s.avgDuration.toFixed(2) : String(s.avgDuration),
          max_ms: Number.isFinite(s.maxDuration) ? s.maxDuration.toFixed(1) : String(s.maxDuration),
        }))
        .sort((a, b) => Number(b.avg_ms) - Number(a.avg_ms))
        .slice(0, 10);
      console.log('io.perOp (top):');
      console.table(perOp);
    }
    if (insights?.length) console.log('insights:', insights.join(' | '));
  } catch (e) {
    console.warn('[perf] failed to stop/print capture:', e);
  }

  // 성능 JSON 출력(옵션)
  if (process.env.PERF_JSON === '1') {
    try {
      // 직전에 stopCapture()로 확보한 result를 그대로 사용
      const state = (globalThis as any).expect?.getState?.() ?? {};
      const testPath: string | undefined = state.testPath;
      const testBase = testPath ? path.basename(testPath).replace(/\.[^.]+$/, '') : 'unknown';
      const now = new Date();
      const stamp =
        String(now.getFullYear()) +
        String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0') +
        '-' +
        [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, '0')).join('');
      const worker = String(process.env.JEST_WORKER_ID || '0');
      const pid = String(process.pid);

      // 기본 저장 디렉터리: <repo>/src/__test__/out/perf
      const repoRoot = process.cwd();
      const defaultDir = path.resolve(repoRoot, 'src', '__test__', 'out', 'perf');
      const outDir = process.env.PERF_JSON_DIR
        ? path.resolve(repoRoot, process.env.PERF_JSON_DIR)
        : defaultDir;
      try { fs.mkdirSync(outDir, { recursive: true }); } catch {}

      const defaultName = `perf-${testBase}-${stamp}-w${worker}-pid${pid}.json`;
      const outPath = process.env.PERF_JSON_FILE
        ? path.resolve(repoRoot, process.env.PERF_JSON_FILE)
        : path.join(outDir, defaultName);

      const payload = {
        schema: 'homey-edgetool.perf.v1',
        ts: Date.now(),
        testFile: testPath ? path.relative(repoRoot, testPath) : undefined,
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        pid: process.pid,
        perf: result, // { duration, samples, functionCalls, analysis{...} }
      };
      // ⛔ 콘솔에는 JSON을 찍지 않음
      // ✅ 파일에만 저장
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
    } catch { /* noop */ }
  }

  (globalThis as any).__JEST_TEST_ACTIVE__ = false;
});
