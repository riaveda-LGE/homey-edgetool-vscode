// === src/__test__/LogFieldExtractionGolden.test.ts ===
// npm test -- --testPathPattern="LogFieldExtractionGolden"
import * as fs from 'fs';
import * as path from 'path';

import {
  compileParserConfig,
  shouldUseParserForFile,
  matchRuleForPath,
  extractByCompiledRule,
} from '../core/logs/ParserEngine.js';

jest.setTimeout(120_000);

type ParsedLine = {
  time: string | null;
  process: string | null;
  pid: string | null;
  message: string | null;
};

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// 템플릿 경로(리포지토리 내 내장 템플릿)
const TEMPLATE_PATH = path.resolve(
  REPO_ROOT,
  'media',
  'resources',
  'custom_log_parser.template.v1.json',
);

// normal_test_suite 경로
const SUITE_DIR = path.join(REPO_ROOT, 'src', '__test__', 'test_log', 'normal_test_suite');
const BEFORE_DIR = path.join(SUITE_DIR, 'before_merge');
// 주의: 리포의 폴더명이 'after_parced' 로 표기되어 있어 그대로 사용합니다(오타 아님).
const AFTER_DIR = path.join(SUITE_DIR, 'after_parced');

function readLines(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw
    .split(/\r?\n/)
    .filter((ln) => ln.trim().length > 0);
}

function toGoldenJsonPath(beforePath: string): string {
  const base = path.basename(beforePath).replace(/\.[^.]+$/, '');
  return path.join(AFTER_DIR, `${base}.json`);
}

// ── 비교 유틸: 시간/메시지 정규화 후 비교 ──────────────────────────────
const ANSI_RE = /\u001b\[[0-9;]*m/g; // \x1b[...m
function normalizeTime(v?: string | null): string {
  if (!v) return '';
  // 시간은 [ ... ] 대괄호를 제거하고 앞뒤만 trim
  return v.replace(/^\[|\]$/g, '').trim();
}
function normalizeMsg(v?: string | null): string {
  if (!v) return '';
  // ANSI 컬러코드 제거 → 탭/스페이스 연속을 1칸으로 → 앞뒤 trim
  return v.replace(ANSI_RE, '').replace(/[ \t]+/g, ' ').trim();
}
function equalLoosely(pa: ParsedLine, pb: ParsedLine): boolean {
  // time: 대괄호 제거 비교, process/pid: 엄격 비교, message: 정규화 비교
  if (normalizeTime(pa.time) !== normalizeTime(pb.time)) return false;
  if ((pa.process ?? '') !== (pb.process ?? '')) return false;
  if ((pa.pid ?? '') !== (pb.pid ?? '')) return false;
  if (normalizeMsg(pa.message) !== normalizeMsg(pb.message)) return false;
  return true;
}

function friendlyDiff(a: ParsedLine[], b: ParsedLine[]) {
  if (a.length !== b.length) {
    return `Length mismatch: parsed=${a.length}, golden=${b.length}`;
  }
  for (let i = 0; i < a.length; i++) {
    const pa = a[i];
    const pb = b[i];
    if (!equalLoosely(pa, pb)) {
      // 어떤 필드가 깨졌는지 친절히 표기
      if (normalizeTime(pa.time) !== normalizeTime(pb.time)) {
        return (
          `First difference at index ${i}, field 'time' (normalized compare):\n` +
          `  parsed(norm) = ${JSON.stringify(normalizeTime(pa.time))}\n` +
          `  golden(norm) = ${JSON.stringify(normalizeTime(pb.time))}\n` +
          `  parsed line obj = ${JSON.stringify(pa)}\n` +
          `  golden line obj = ${JSON.stringify(pb)}`
        );
      }
      if ((pa.process ?? '') !== (pb.process ?? '')) {
        return (
          `First difference at index ${i}, field 'process':\n` +
          `  parsed = ${JSON.stringify(pa.process)}\n` +
          `  golden = ${JSON.stringify(pb.process)}\n` +
          `  parsed line obj = ${JSON.stringify(pa)}\n` +
          `  golden line obj = ${JSON.stringify(pb)}`
        );
      }
      if ((pa.pid ?? '') !== (pb.pid ?? '')) {
        return (
          `First difference at index ${i}, field 'pid':\n` +
          `  parsed = ${JSON.stringify(pa.pid)}\n` +
          `  golden = ${JSON.stringify(pb.pid)}\n` +
          `  parsed line obj = ${JSON.stringify(pa)}\n` +
          `  golden line obj = ${JSON.stringify(pb)}`
        );
      }
      if (normalizeMsg(pa.message) !== normalizeMsg(pb.message)) {
        return (
          `First difference at index ${i}, field 'message' (normalized compare):\n` +
          `  parsed(norm) = ${JSON.stringify(normalizeMsg(pa.message))}\n` +
          `  golden(norm) = ${JSON.stringify(normalizeMsg(pb.message))}\n` +
          `  parsed line obj = ${JSON.stringify(pa)}\n` +
          `  golden line obj = ${JSON.stringify(pb)}`
        );
      }
    }
  }
  return 'No differences';
}

describe('normal_test_suite golden diff', () => {
  it('before_merge/*.log 을 파싱한 결과가 after_parced/*.json 과 정확히 일치한다', async () => {
    // 파서 컴파일
    const tpl = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
    const cp = compileParserConfig(tpl)!;
    expect(cp).toBeTruthy();
    expect(cp.version).toBe(1);

    // 입력 로그 후보 수집
    const beforeFiles = fs
      .readdirSync(BEFORE_DIR)
      .filter((f) => fs.statSync(path.join(BEFORE_DIR, f)).isFile())
      // 일반적으로 *.log 만 비교(필요시 확장 가능)
      .filter((f) => /\.log(\.\d+)?$/.test(f));

    if (beforeFiles.length === 0) {
      throw new Error(`No log files found in ${BEFORE_DIR}`);
    }

    // 파일별 파싱 및 golden 비교
    for (const fname of beforeFiles) {
      const beforeFull = path.join(BEFORE_DIR, fname);
      const relForRule = fname.replace(/\\/g, '/'); // 글롭 매칭은 상대경로 기반
      const rule = matchRuleForPath(relForRule, cp);
      expect(rule).toBeTruthy();

      const shouldUse = await shouldUseParserForFile(beforeFull, relForRule, cp);
      if (!shouldUse) {
          throw new Error(`Preflight failed (shouldUse=false) for file: ${fname}`);
      }
      expect(shouldUse).toBe(true);

      const lines = readLines(beforeFull);
      const parsed: ParsedLine[] = lines.map((line, idx) => {
        const f = extractByCompiledRule(line, rule!);
        // 요구 필드(time, process, message)는 반드시 존재해야 함
        if (!f || !f.time || !f.process || !f.message) {
          throw new Error(
            `Required fields missing at ${fname}:${idx + 1}\n` +
              `line=${JSON.stringify(line)}\n` +
              `extracted=${JSON.stringify(f)}`,
          );
        }
        return {
          time: f.time ?? null,
          process: f.process ?? null,
          pid: f.pid ?? null,
          message: f.message ?? null,
        };
      });

      const goldenPath = toGoldenJsonPath(beforeFull);
      expect(fs.existsSync(goldenPath)).toBe(true);

      const golden: ParsedLine[] = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));

      // 느슨한 규칙(시간 대괄호 무시, 메시지 공백/ANSI 정규화)으로 비교
      const detail = friendlyDiff(parsed, golden);
      if (detail !== 'No differences') {
        throw new Error(
          `Parsed output does not match golden for "${fname}".\n` +
            `Golden: ${path.relative(REPO_ROOT, goldenPath)}\n` +
            detail,
        );
      }
    }
  });
});
