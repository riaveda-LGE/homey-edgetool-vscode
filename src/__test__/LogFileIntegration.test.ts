// === src/__test__/LogFileIntegration.test.ts ===
import type { LogEntry } from '@ipc/messages';
import * as fs from 'fs';
import * as path from 'path';

import { countTotalLinesInDir, mergeDirectory } from '../core/logs/LogFileIntegration.js';
import type { ParserConfig } from '../core/logs/ParserEngine.js';
import {
  cleanAndEnsureDir,
  cleanDir,
  drainNextTicks,
  prepareUniqueOutDir,
} from './helpers/testFs.js';
import { PARSER_TEMPLATE_REL } from '../shared/const.js';

jest.setTimeout(60_000);

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

// ⬇️ 주의: 이 통합 테스트는 **원본 라인 전체**(time/process/pid/message)를 비교합니다.
// parser는 내장 템플릿(JSON)을 로드해서 사용하고, mergeDirectory 옵션 `preserveFullText`로
// 헤더를 복원해 비교합니다(운영과 동일한 ParserEngine 경로를 강제).

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

  // ⏱️ 무진행 감시: 45초 + merged/*.jsonl 크기 증가를 진행으로 인정(오탐 방지)
  const WATCHDOG_MS = 45_000;
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
    mergeDirectory({
      dir: inputDir,
      mergedDirPath: mergedDir,
      onBatch,
      batchSize: 1000,
      // ✅ 내장 템플릿 파서 적용 + 헤더 복원: 운영 경로와 동일하게 ParserEngine을 거치되
      //    테스트 비교는 전체 헤더 형태로 수행
      parser: loadTemplateParserConfig(),
      preserveFullText: true,
    }),
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
      return;
    }
    throw new Error(`Test failed with ${mismatches.length} line mismatches\n` + mismatches.join('\n'));
  }

  console.log(`✅ ${testName} passed: ${actualResults.length} lines merged correctly`);
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
    it('일반 로그 파일들을 정확히 병합해야 함', async () => {
      await runMergeTest('Normal test', 'normal_test_suite', 'normal_result_merged.log');
    }, 60_000);

    it('타임존 점프가 있는 로그 파일들을 정확히 병합해야 함', async () => {
      await runMergeTest('Timezone test', 'timezone_jump_test_suite', 'timezone_result_merged.log');
    }, 60_000);

    it('빈 디렉터리를 gracefully 처리해야 함', async () => {
      const tempDir = path.join(OUT_DIR, 'temp_empty');
      cleanAndEnsureDir(tempDir);

      const mergedDir = path.join(OUT_DIR, 'merged');
      cleanAndEnsureDir(mergedDir);

      const onBatch = jest.fn((logs: LogEntry[]) => {
        expect(Array.isArray(logs)).toBe(true);
        expect(logs.length).toBe(0);
      });

      await mergeDirectory({ dir: tempDir, onBatch, mergedDirPath: mergedDir });

      expect(onBatch).not.toHaveBeenCalled();
    }, 60_000);

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
        mergeDirectory({
          dir: inputDir,
          onBatch,
          signal: abortController.signal,
          batchSize: 1,
          mergedDirPath: mergedDir,
        }),
      ).resolves.toBeUndefined();

      expect(abortedAt).not.toBeNull();
      expect(postAbortBatches).toBe(0);
      expect(batchCount).toBe(abortedAt);
      const { total } = await countTotalLinesInDir(inputDir);
      expect(emittedLines).toBeLessThan(total);
    }, 60_000);
  });
});