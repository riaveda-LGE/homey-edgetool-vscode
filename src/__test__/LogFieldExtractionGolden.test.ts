// npm test -- --testPathPattern="LogRoundtripReconstruction"

import * as fs from 'fs';
import * as path from 'path';

import {
  compileParserConfig,
  shouldUseParserForFile,
  matchRuleForPath,
  extractByCompiledRule,
} from '../core/logs/ParserEngine.js';
import { measureBlock } from '../core/logging/perf.js';

jest.setTimeout(120_000);

type ParsedLine = {
  time: string | null;
  process: string | null;
  pid: string | null;
  message: string | null;
};

type SrcLine = { n: number; text: string }; // 실제 원본 줄 번호 포함

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_PATH = path.resolve(
  REPO_ROOT,
  'media',
  'resources',
  'custom_log_parser.template.v1.json',
);
const SUITE_DIR = path.join(REPO_ROOT, 'src', '__test__', 'test_log', 'normal_test_suite');
const BEFORE_DIR = path.join(SUITE_DIR, 'before_merge');

// ── 유틸 ─────────────────────────────────────────────────────────────
const ANSI_RE = /\u001b\[[0-9;]*m/g; // \x1b[...m
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** 파일에서 빈 줄 포함 전체를 읽고, 테스트에는 "비어있지 않은 줄"만 투입하면서 원본 줄 번호(n)를 보존 */
function readLinesWithNumbers(filePath: string): SrcLine[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parts = raw.split(/\r?\n/);
  const out: SrcLine[] = [];
  for (let i = 0; i < parts.length; i++) {
    const text = parts[i] ?? '';
    if (text.trim().length > 0) out.push({ n: i + 1, text });
  }
  return out;
}

/** 시각화: 눈에 안 보이는 문자들을 토큰으로 치환 */
function visualize(s: string): string {
  return s
    .replace(/\uFEFF/g, '<BOM>')  // BOM 보이기
    .replace(/\t/g, '<TAB>')
    .replace(/\r/g, '<CR>')
    .replace(/\n/g, '<LF>');
}

/** 바이트 헥스 문자열 (최대 max 바이트) */
function toHex(buf: Buffer, max = 64): string {
  const view = buf.subarray(0, Math.min(buf.length, max));
  return Array.from(view).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** 코드포인트 헥스 (문자 단위) */
function toCodepointsHex(s: string, max = 64): string {
  const arr = Array.from(s);
  const sliced = arr.slice(0, max);
  return sliced.map((ch) => ch.codePointAt(0)!.toString(16).padStart(4, '0')).join(' ');
}

/** 파일 헤더 헥스 + BOM 여부 */
function fileHeaderInfo(filePath: string): string {
  const raw = fs.readFileSync(filePath);
  const head = toHex(raw, 16);
  const hasUtf8Bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  return `file-header-hex(16): ${head}${hasUtf8Bom ? '  [UTF-8 BOM detected]' : ''}`;
}

/** message 앞쪽의 리딩 공백을 1개까지만 제거해, 우리가 넣는 ': ' 과 중복되지 않게 함 */
function removeOneLeadingSpace(s: string): string {
  if (!s) return s;
  return s.replace(/^\s/, '');
}

/** 파싱 결과로 원본 라인을 복원 */
function reconstructLine(p: ParsedLine): string {
  const t = (p.time ?? '').toString();
  const proc = (p.process ?? '').toString();
  const pidRaw = (p.pid ?? '').toString().trim();
  const pidBlock = pidRaw ? `[${pidRaw}]` : '';
  const msg0 = (p.message ?? '').toString();
  const msg = removeOneLeadingSpace(msg0); // ': ' 과 중복 방지
  // 원 포맷: [time] process[pid]: message
  return `[${t}] ${proc}${pidBlock}: ${msg}`;
}

/** 비교용 정규화: ANSI 제거 + 탭/스페이스 연속을 1칸으로 + 앞뒤 trim */
function normalizeForCompare(fullLine: string): string {
  return stripAnsi(fullLine)
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** 차이 지점 상세(시각화 + 헥스) */
function prettyFirstDiff(a: string[], b: string[]) {
  if (a.length !== b.length) {
    return `Length mismatch: reconstructed=${a.length}, original=${b.length}`;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      const visA = visualize(a[i]);
      const visB = visualize(b[i]);
      const hexA = toHex(Buffer.from(a[i], 'utf8'));
      const hexB = toHex(Buffer.from(b[i], 'utf8'));
      const cpA = toCodepointsHex(a[i]);
      const cpB = toCodepointsHex(b[i]);
      return (
        `First difference at index ${i}:\n` +
        `  reconstructed(vis) = ${JSON.stringify(visA)}\n` +
        `  original     (vis) = ${JSON.stringify(visB)}\n` +
        `  reconstructed(hex) = ${hexA}\n` +
        `  original     (hex) = ${hexB}\n` +
        `  reconstructed(cps) = ${cpA}\n` +
        `  original     (cps) = ${cpB}`
      );
    }
  }
  return 'No differences';
}

// ── 테스트 본문 ───────────────────────────────────────────────────────
describe('Log roundtrip reconstruction (ANSI/whitespace-insensitive)', () => {
  it('before_merge/*.log → (parse) → (reconstruct) → 원본과 동일', async () => {
    const tpl = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
    const cp = measureBlock('compile-parser-config-roundtrip', () => compileParserConfig(tpl))!;
    expect(cp).toBeTruthy();
    expect(cp.version).toBe(1);

    const beforeFiles = fs
      .readdirSync(BEFORE_DIR)
      .filter((f) => fs.statSync(path.join(BEFORE_DIR, f)).isFile())
      .filter((f) => /\.log(\.\d+)?$/i.test(f))
      .sort();

    if (beforeFiles.length === 0) {
      throw new Error(`No log files found in ${BEFORE_DIR}`);
    }

    for (const fname of beforeFiles) {
      const full = path.join(BEFORE_DIR, fname);
      const rel = fname.replace(/\\/g, '/');

      const rule = measureBlock('match-rule-for-path-roundtrip', () => matchRuleForPath(rel, cp));
      expect(rule).toBeTruthy();

      const shouldUse = await measureBlock('should-use-parser-for-file-roundtrip', () =>
        shouldUseParserForFile(full, rel, cp),
      );
      if (!shouldUse) {
        throw new Error(
          `Preflight failed (shouldUse=false) for file: ${fname}\n` +
            `${fileHeaderInfo(full)}\n` +
            `rule.regex = ${JSON.stringify({
              time: String(rule!.regex.time || ''),
              process: String(rule!.regex.process || ''),
              pid: String(rule!.regex.pid || ''),
              message: String(rule!.regex.message || ''),
            })}`,
        );
      }

      // 파일 헤더(헥스) → BOM 즉시 눈으로 확인
      // (Jest는 console.log도 실패 시 출력되므로 즉시 찍어 둔다)
      console.log(`[debug] ${fname}: ${fileHeaderInfo(full)}`);

      const src = readLinesWithNumbers(full);

      const parsed: ParsedLine[] = [];
      for (let i = 0; i < src.length; i++) {
        const { n, text } = src[i];
        try {
          const f = measureBlock('extract-by-compiled-rule-roundtrip', () =>
            extractByCompiledRule(text, rule!),
          );
          if (!f || !f.time || !f.process || !f.message) {
            const vis = visualize(text);
            const hex = toHex(Buffer.from(text, 'utf8'));
            const cps = toCodepointsHex(text);
            const hasLeadingBom = text.charCodeAt(0) === 0xfeff;
            throw new Error(
              `Required fields missing at ${fname}:${n} (index=${i})\n` +
                `rule.regex = ${JSON.stringify({
                  time: String(rule!.regex.time || ''),
                  process: String(rule!.regex.process || ''),
                  pid: String(rule!.regex.pid || ''),
                  message: String(rule!.regex.message || ''),
                })}\n` +
                `line(vis) = ${JSON.stringify(vis)}\n` +
                `line(hex) = ${hex}\n` +
                `line(cps) = ${cps}\n` +
                `hasLeadingBOM = ${hasLeadingBom}\n` +
                `extracted = ${JSON.stringify(f)}`,
            );
          }
          parsed.push({
            time: f.time ?? null,
            process: f.process ?? null,
            pid: f.pid ?? null,
            message: f.message ?? null,
          });
        } catch (e: any) {
          // 캐치해서 파일 헤더도 함께 보여주고 재던짐
          const enriched =
            `\n[debug] file=${fname} at originalLine=${n} index=${i}\n` +
            `${fileHeaderInfo(full)}\n` +
            (e?.message || e);
          throw new Error(enriched);
        }
      }

      // (parse) → (reconstruct)
      const reconstructed = parsed.map(reconstructLine).map(normalizeForCompare);
      // 원본(ANSI 제거 + 공백 정규화)
      const original = src.map((l) => normalizeForCompare(l.text));

      const detail = prettyFirstDiff(reconstructed, original);
      if (detail !== 'No differences') {
        throw new Error(
          `Roundtrip mismatch for "${fname}".\n` +
            `Before: ${path.relative(REPO_ROOT, full)}\n` +
            detail,
        );
      }
    }
  });
});
