// === src/__test__/LogFileIntegration.test.ts ===
import type { LogEntry } from '@ipc/messages';
import * as fs from 'fs';
import * as path from 'path';

import { countTotalLinesInDir, mergeDirectory } from '../core/logs/LogFileIntegration.js';
import { measureBlock } from '../core/logging/perf.js';
import type { ParserConfig } from '../core/logs/ParserEngine.js';
import {
  cleanAndEnsureDir,
  cleanDir,
  drainNextTicks,
  prepareUniqueOutDir,
} from './helpers/testFs.js';
import { PARSER_TEMPLATE_REL } from '../shared/const.js';

jest.setTimeout(600_000);

// ── 메시지 비교 정규화(ANSI 제거 + 공백 축약 + trim) ─────────────────────
const ANSI_RE = /\u001b\[[0-9;]*m/g; // \x1b[...m
function normalizeText(s: string): string {
  return s.replace(ANSI_RE, '').replace(/[ \t]+/g, ' ').trim();
}

// 골든 자동 갱신(실제 결과로 after_merge/merged.log 덮어쓰기)
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === '1';

// ── merged.log 한 줄을 (time/process/pid/message)로 분해 ────────────────
// 형식: "[Mon DD HH:MM:SS(.mmm)] process[pid]?: message"
const MERGED_LINE_RE =
  /^\[(?<time>[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d{3,6})?)\]\s+(?<proc>[A-Za-z0-9._-]+)(?:\[(?<pid>\d+)\])?:\s+(?<msg>.*)$/;
type ExpectedParsed = { time: string | null; process: string | null; pid: string | null; message: string | null };
function parseMergedLine(line: string): ExpectedParsed {
  const m = MERGED_LINE_RE.exec(line);
  if (!m?.groups) return { time: null, process: null, pid: null, message: line };
  return {
    time: m.groups.time ?? null,               // 이미 대괄호 내부만 캡쳐됨
    process: m.groups.proc ?? null,
    pid: m.groups.pid ?? null,
    message: m.groups.msg ?? null,
  };
}
function extractMergedHeader(line: string): string | null {
  const m = MERGED_LINE_RE.exec(line);
  if (!m?.groups) return null;
  const pid = m.groups.pid ? `[${m.groups.pid}]` : '';
  return `[${m.groups.time}] ${m.groups.proc}${pid}: `;
}

// ⬇️ 추가: 시간 파서(연도 앵커 고정) + 단조성 검증 유틸
const MONTH = new Map<string, number>([
  ['Jan', 0], ['Feb', 1], ['Mar', 2], ['Apr', 3], ['May', 4], ['Jun', 5],
  ['Jul', 6], ['Aug', 7], ['Sep', 8], ['Oct', 9], ['Nov', 10], ['Dec', 11],
]);
const HEADER_TIME_RE =
  /^(?<mon>[A-Za-z]{3})\s+(?<dd>\d{1,2})\s+(?<hh>\d{2}):(?<mm>\d{2}):(?<ss>\d{2})(?:\.(?<ms>\d{3,6}))?$/;
function parseHeaderTimeToMs(s: string, yearAnchor = 2025): number | null {
  const m = HEADER_TIME_RE.exec(s);
  if (!m?.groups) return null;
  const mon = MONTH.get(m.groups.mon);
  if (mon == null) return null;
  const dd = Number(m.groups.dd);
  const hh = Number(m.groups.hh);
  const mm = Number(m.groups.mm);
  const ss = Number(m.groups.ss);
  let ms = 0;
  if (m.groups.ms) {
    const raw = m.groups.ms;
    // 마이크로초까지 들어오면 밀리초로 보정(반올림)
    ms = Math.round(Number(raw.padEnd(3, '0').slice(0, 3)));
  }
  return Date.UTC(yearAnchor, mon, dd, hh, mm, ss, ms);
}

function assertMonotonicDesc(label: string, arr: Array<number | null>) {
  const errs: string[] = [];
  for (let i = 0; i + 1 < arr.length; i++) {
    const a = arr[i];
    const b = arr[i + 1];
    if (a == null || b == null) continue; // 정보 없는 라인은 스킵
    if (a < b) {
      errs.push(`non-desc at index ${i} → ${i + 1}: ${a} < ${b}`);
      if (errs.length >= 20) break;
    }
  }
  if (errs.length) {
    throw new Error(`[${label}] time must be non-increasing (latest→oldest). First issues:\n` + errs.join('\n'));
  }
}

// JSONL 스캔: mergedDir 안의 *.jsonl에서 최대 N라인 읽고 객체 배열 반환(필드가 있으면 불변식 검증에 활용)
const DEBUG_SCAN_LIMIT = 100_000;
function readMergedJsonlObjects(mergedDir: string): any[] {
  if (!fs.existsSync(mergedDir)) return [];
  const names = fs.readdirSync(mergedDir).filter(n => n.endsWith('.jsonl'));
  const out: any[] = [];
  for (const n of names) {
    const fp = path.join(mergedDir, n);
    const data = fs.readFileSync(fp, 'utf8');
    const lines = data.split('\n');
    for (const ln of lines) {
      if (!ln || ln[0] !== '{') continue;
      try {
        out.push(JSON.parse(ln));
        if (out.length >= DEBUG_SCAN_LIMIT) return out;
      } catch {
        // skip
      }
    }
  }
  return out;
}

// 내부 ts/원시 ts 키 후보를 스캔해서 "가장 많이 보이는" 키를 선택
function pickBestNumericKey(objs: any[], candidates: string[]): string | null {
  const cnt = new Map<string, number>();
  for (const c of candidates) cnt.set(c, 0);
  for (const o of objs) {
    for (const c of candidates) {
      const v = (o as any)[c];
      if (typeof v === 'number' && Number.isFinite(v)) {
        cnt.set(c, (cnt.get(c) || 0) + 1);
      }
    }
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [k, v] of cnt) {
    if (v > bestN) { best = k; bestN = v; }
  }
  return bestN > 0 ? best : null;
}

let OUT_DIR: string;

// 테스트에서 사용할 파서 설정을 템플릿 JSON으로부터 로드
function loadTemplateParserConfig(): ParserConfig {
  // __dirname: src/__test__ → 두 단계 상위가 repo root
  const templatePath = path.resolve(__dirname, '..', '..', PARSER_TEMPLATE_REL);
  const buf = fs.readFileSync(templatePath, 'utf8');
  const json = JSON.parse(buf);
  return json as ParserConfig;
}

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
  // 기대 스냅샷(plain text) → 구조화
  const expectedParsed = expectedLines.map(parseMergedLine).map((p) => ({
    ...p,
    message: p.message != null ? normalizeText(p.message) : null,
  }));

  console.log(
    `📊 ${testName} - Expected lines: ${expectedLines.length}, first line: "${expectedLines[0]}"`,
  );

  const outDir = OUT_DIR;
  const mergedDir = path.join(OUT_DIR, 'merged');
  fs.mkdirSync(mergedDir, { recursive: true });

  // 디버그 산출물 폴더
  const debugDir = path.join(OUT_DIR, 'debug');
  fs.mkdirSync(debugDir, { recursive: true });
  console.log(`🧪 debug artifacts → ${debugDir}`);

  const actualResults: LogEntry[] = [];
  const outputPath = path.join(OUT_DIR, outputFileName);
  const outputStream = fs.createWriteStream(outputPath, { encoding: 'utf8' });

  // 진행 감시(무진행 watchdog)
  let lastProgressAt = Date.now();

  const onBatch = (logs: LogEntry[]) => {
    actualResults.push(...logs);
    for (const log of logs) outputStream.write(log.text + '\n');
    lastProgressAt = Date.now();
  };

  // ⏱️ 무진행 감시
  const WATCHDOG_MS = 600_000;
  let watchdogTimer: NodeJS.Timeout | undefined;
  let statTimer: NodeJS.Timeout | undefined;
  // mergedDir 안의 .jsonl 파일 크기가 증가하면 진행으로 간주
  const mergedSizes = new Map<string, number>();
  statTimer = setInterval(() => {
    try {
      const names = fs.existsSync(mergedDir) ? fs.readdirSync(mergedDir) : [];
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const fp = path.join(mergedDir, n);
        const st = fs.statSync(fp);
        const prev = mergedSizes.get(n) || 0;
        if (st.size > prev) {
          mergedSizes.set(n, st.size);
          lastProgressAt = Date.now();
        }
      }
    } catch {}
  }, 500);

  const watchdog = new Promise<void>((_resolve, reject) => {
    watchdogTimer = setInterval(() => {
      if (Date.now() - lastProgressAt > WATCHDOG_MS) {
        clearInterval(watchdogTimer!);
        if (statTimer) clearInterval(statTimer);
        reject(
          new Error(
            `Watchdog: no progress for ${WATCHDOG_MS / 1000}s (test="${testName}", suite="${testSuiteDir}")`,
          ),
        );
      }
    }, 1000);
  });

  await Promise.race([
    measureBlock('merge-directory-run-merge-test', () =>
      mergeDirectory({
        dir: inputDir,
        mergedDirPath: mergedDir,
        onBatch,
        batchSize: 1000,
        // ✅ ParserEngine 경로 강제 + 헤더 복원
        parser: loadTemplateParserConfig(),
        preserveFullText: true,
      })
    ),
    watchdog,
  ]).finally(() => {
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (statTimer) clearInterval(statTimer);
  });

  await drainNextTicks();
  await new Promise<void>((resolve) => { outputStream.end(() => resolve()); });

  expect(actualResults.length).toBe(expectedLines.length);

  // mergeDirectory는 "최신→오래된(desc)"으로 배출한다.
  // 기대 스냅샷도 "최신→오래된(desc)"이므로 같은 인덱스로 비교한다.
  const actualTexts = actualResults.map((e) => e.text);
  const actualParsed = actualTexts.map(parseMergedLine).map((p) => ({
    ...p,
    message: p.message != null ? normalizeText(p.message) : null,
  }));

  // 🔎 디버깅 산출물
  // 1) 원본(raw)
  fs.writeFileSync(
    path.join(debugDir, `${outputFileName}.expected_raw.log`),
    expectedLines.join('\n') + '\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(debugDir, `${outputFileName}.actual_raw.log`),
    actualTexts.join('\n') + '\n',
    'utf8',
  );
  // 2) message-only
  const expectedMsgs = expectedLines.map((ln) => parseMergedLine(ln).message ?? ln);
  const actualMsgs = actualTexts.map((ln) => parseMergedLine(ln).message ?? ln);
  fs.writeFileSync(
    path.join(debugDir, `${outputFileName}.expected_message_only.log`),
    expectedMsgs.join('\n') + '\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(debugDir, `${outputFileName}.actual_message_only.log`),
    actualMsgs.join('\n') + '\n',
    'utf8',
  );
  // 3) 구조화 JSON
  fs.writeFileSync(
    path.join(debugDir, `${outputFileName}.expected_structured.json`),
    JSON.stringify(expectedParsed, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(debugDir, `${outputFileName}.actual_structured.json`),
    JSON.stringify(actualParsed, null, 2),
    'utf8',
  );
  // 기존 헤더를 유지하고, body만 실제 결과로 대체한 "스냅샷 제안본"
  const snapshotSuggested = expectedLines.map((ln, i) => {
    const header = extractMergedHeader(ln);
    const body = actualTexts[i] ?? '';
    return header ? header + body : body;
  });
  fs.writeFileSync(
    path.join(debugDir, `snapshot_suggested_new_${outputFileName}`),
    snapshotSuggested.join('\n') + '\n',
    'utf8',
  );

  // ────────────────────────────────────────────────────────────────────────────
  // ✅ 1) 스냅샷 비교(기존)
  const mismatches: string[] = [];
  for (let i = 0; i < expectedLines.length; i++) {
    const exp = expectedParsed[i]!;
    const act = actualParsed[i]!;
    const fieldsMatch =
      exp.time === act.time &&
      exp.process === act.process &&
      exp.pid === act.pid &&
      exp.message === act.message;

    if (!fieldsMatch) {
      mismatches.push(
        `Entry ${i + 1} (parsed field mismatch):\n` +
          `  Expected: time="${exp.time}", process="${exp.process}", pid="${exp.pid}", message="${exp.message}"\n` +
          `  Actual:   time="${act.time}", process="${act.process}", pid="${act.pid}", message="${act.message}"\n` +
          `  Raw expected: "${expectedLines[i]}"\n` +
          `  Raw actual:   "${actualTexts[i]}"`,
      );
      if (mismatches.length >= 20) break;
    }
  }
  if (mismatches.length > 0) {
    if (UPDATE_GOLDEN) {
      // 실제 결과로 golden 갱신
      fs.writeFileSync(expectedOutputPath, actualTexts.join('\n') + '\n', 'utf8');
      // 구조화 기대값도 함께 남김(참고용)
      const structuredOut = path.join(path.dirname(expectedOutputPath), 'merged_structured.golden.json');
      fs.writeFileSync(structuredOut, JSON.stringify(actualParsed, null, 2), 'utf8');
      console.log(`🟡 Golden updated: ${expectedOutputPath}`);
      console.log(`🟡 Structured golden: ${structuredOut}`);
    } else {
      throw new Error(`Test failed with ${mismatches.length} line mismatches\n` + mismatches.join('\n'));
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ✅ 2) “헤더 시간” 단조성(내림차순) 검증 → 화면이 보정 결과와 불일치해도 최소한 역행은 방지
  const headerTimes = actualParsed.map(p => (p.time ? parseHeaderTimeToMs(p.time!) : null));
  assertMonotonicDesc(`${testName}: header-time`, headerTimes);

  // ────────────────────────────────────────────────────────────────────────────
  // ✅ 3) merged/*.jsonl 내부 타임스탬프/타임존 품질 지표 검증(있으면)
  const jsonlObjs = readMergedJsonlObjects(mergedDir);
  if (jsonlObjs.length > 0) {
    // 3-1) 내부 병합 타임스탬프 단조성(ts 계열)
    const tsKey = pickBestNumericKey(jsonlObjs, ['ts', 'tsMs', 'timeMs', 't', 'mergedTs']);
    if (tsKey) {
      const arr = jsonlObjs.map(o => {
        const v = o?.[tsKey];
        return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
      });
      assertMonotonicDesc(`${testName}: internal-${tsKey}`, arr);
    } else {
      console.warn(`[${testName}] skip: no internal ts key found in JSONL`);
    }

    // 3-2) 입력(raw) 타임 피드 방향(대부분 감소해야 함)
    const rawKey = pickBestNumericKey(jsonlObjs, ['srcTs', 'srcTsMs', 'rawTs', 'tsRaw', 'origTs', 'sourceTs']);
    if (rawKey) {
      let inc = 0, dec = 0, same = 0, prev: number | null = null;
      for (const o of jsonlObjs) {
        const v = o?.[rawKey];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        if (prev != null) {
          if (v > prev) inc++; else if (v < prev) dec++; else same++;
        }
        prev = v;
      }
      const totalPairs = inc + dec + same;
      if (totalPairs > 50) { // 유의미할 때만
        const decRatio = dec / Math.max(1, (inc + dec));
        expect(decRatio).toBeGreaterThanOrEqual(0.7); // 최신→오래됨 방향성 대략 보장
      }
    } else {
      console.warn(`[${testName}] skip: no raw-ts key found in JSONL`);
    }

    // 3-3) 타임존 점프 품질 지표(있으면 검증)
    // 라인 단위 플래그 후보: tzSuspected, tzFixed, tzClamped 혹은 tz:{suspected,fixed,clamped}
    let suspected = 0, fixed = 0, clamped = 0, total = 0;
    for (const o of jsonlObjs) {
      const tz = o?.tz;
      const s = (tz?.suspected ?? o?.tzSuspected) ? 1 : 0;
      const f = (tz?.fixed ?? o?.tzFixed) ? 1 : 0;
      const c = (tz?.clamped ?? o?.tzClamped ?? o?.clamped) ? 1 : 0;
      suspected += s; fixed += f; clamped += c; total++;
    }
    if (suspected > 0 || fixed > 0 || clamped > 0) {
      // “의심이 있었으면” “수정도 있었어야”
      expect(fixed).toBeGreaterThan(0);
      // 과도한 클램프 방지(기본 5%)
      const clampRatio = clamped / Math.max(1, total);
      expect(clampRatio).toBeLessThanOrEqual(0.05);
    } else {
      console.warn(`[${testName}] skip: no tz quality flags found in JSONL`);
    }
  }

  console.log(`✅ ${testName} passed: ${actualResults.length} lines merged correctly (with invariants)`);
}

// 배치 크기에 무관한 결정적 결과 보장 테스트(추가)
async function runDeterminismTest(testName: string, testSuiteDir: string) {
  const testDir = path.resolve(__dirname, 'test_log', testSuiteDir);
  const inputDir = path.join(testDir, 'before_merge');

  const outA = prepareUniqueOutDir('detA'); cleanAndEnsureDir(outA);
  const outB = prepareUniqueOutDir('detB'); cleanAndEnsureDir(outB);

  const runOnce = async (out: string, batchSize: number) => {
    const mergedDir = path.join(out, 'merged');
    cleanAndEnsureDir(mergedDir);
    const texts: string[] = [];
    await measureBlock(`${testName}-det-${batchSize}`, () =>
      mergeDirectory({
        dir: inputDir,
        mergedDirPath: mergedDir,
        batchSize,
        parser: loadTemplateParserConfig(),
        preserveFullText: true,
        onBatch: (logs) => { for (const l of logs) texts.push(l.text); },
      })
    );
    return texts;
  };

  const a = await runOnce(outA, 1);
  const b = await runOnce(outB, 1000);

  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      throw new Error(
        `Determinism mismatch at ${i + 1}\nA: ${a[i]}\nB: ${b[i]}`
      );
    }
  }
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
    it('일반 로그 파일들을 정확히 병합해야 함(+불변식 검증)', async () => {
      await runMergeTest('Normal test', 'normal_test_suite', 'normal_result_merged.log');
    }, 600_000);

    it('타임존 점프가 있는 로그 파일들을 정확히 병합해야 함(+불변식 검증)', async () => {
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

      await measureBlock('merge-directory-empty-dir', () =>
        mergeDirectory({ dir: tempDir, onBatch, mergedDirPath: mergedDir })
      );

      expect(onBatch).not.toHaveBeenCalled();
    }, 600_000);

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
        measureBlock('merge-directory-abort-test', () =>
          mergeDirectory({
            dir: inputDir,
            onBatch,
            signal: abortController.signal,
            batchSize: 1,
            mergedDirPath: mergedDir,
          })
        ),
      ).resolves.toBeUndefined();

      expect(abortedAt).not.toBeNull();
      expect(postAbortBatches).toBe(0);
      expect(batchCount).toBe(abortedAt);
      const { total } = await measureBlock('count-total-lines-in-dir', () =>
        countTotalLinesInDir(inputDir)
      );
      expect(emittedLines).toBeLessThan(total);
    }, 600_000);

    // ⬇️ 추가: 결정성(배치 크기 변화에도 동일 결과)
    it('배치 크기에 상관없이 결정적 결과를 내야 함', async () => {
      await runDeterminismTest('Determinism', 'timezone_jump_test_suite');
    }, 600_000);
  });
});
