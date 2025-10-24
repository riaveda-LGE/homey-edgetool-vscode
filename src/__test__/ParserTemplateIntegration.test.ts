// === src/__test__/ParserTemplateIntegration.test.ts ===
import * as fs from 'fs';
import * as path from 'path';

import {
  compileParserConfig,
  shouldUseParserForFile,
  matchRuleForPath,
  extractByCompiledRule,
} from '../core/logs/ParserEngine.js';
import { cleanAndEnsureDir } from './helpers/testFs.js';
import { measureBlock } from '../core/logging/perf.js';

jest.setTimeout(120_000);

// 리포 루트/출력 폴더
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PARSED_OUT_DIR = path.join(REPO_ROOT, 'parsed_item');
// 실제 테스트 입력 폴더(이미 존재)
const FIX_INPUT_DIR = path.resolve(
  __dirname,
  'test_log',
  'normal_test_suite',
  'before_merge',
);
// 템플릿 경로(리포 내장)
const TEMPLATE_PATH = path.resolve(
  REPO_ROOT,
  'media',
  'resources',
  'custom_log_parser.template.v1.json',
);

beforeEach(() => {
  cleanAndEnsureDir(PARSED_OUT_DIR); // 산출물 폴더는 남겨둠(지우지 않음)
});

// 유틸: 파일에서 최대 N줄만 빠르게 읽기
function readFirstLines(filePath: string, max = 200): string[] {
  const txt = fs.readFileSync(filePath, 'utf8');
  const lines = txt.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const ln = String(lines[i] || '').trimEnd();
    if (ln.length) out.push(ln);
  }
  return out;
}

// 프리플라이트 하드-스킵 패턴을 템플릿(cp)에서 읽어 RegExp로 준비
function getHardSkipRegexesFromConfig(cp: any): RegExp[] {
  const arr = cp?.preflight?.hard_skip_if_any_line_matches ?? [];
  if (!Array.isArray(arr)) return [];
  // compileParserConfig 결과가 이미 RegExp일 수도 있으므로 그대로 사용
  if (arr.length && arr[0] instanceof RegExp) return arr as RegExp[];
  // 문자열이면 RegExp로 컴파일 (템플릿 패턴 그대로, 별도 플래그 없음)
  return (arr as string[]).map((pat) => new RegExp(pat));
}

it('템플릿이 정상 컴파일되고 요구/프리플라이트/글롭 매칭이 적용된다', async () => {
  const tpl = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  const cp = measureBlock('compile-parser-config-template-integration', () => compileParserConfig(tpl))!;
  expect(cp).toBeTruthy();
  expect(cp.version).toBe(1);

  // 요구 필드가 템플릿대로 설정되었는지 확인
  expect(cp.requirements.fields.time).toBe(true);
  expect(cp.requirements.fields.process).toBe(true);
  expect(cp.requirements.fields.pid).toBe(false);
  expect(cp.requirements.fields.message).toBe(true);

  // 프리플라이트 기본값/설정값 확인
  expect(cp.preflight.sample_lines).toBe(200);
  expect(cp.preflight.min_match_ratio).toBeCloseTo(0.8, 5);

  // 실제 입력 폴더에서 파일 수집 (*.log / *.log.N)
  const names = fs
    .readdirSync(FIX_INPUT_DIR)
    .filter((n) => /\.log(\.\d+)?$/i.test(n))
    .sort();
  expect(names.length).toBeGreaterThan(0);

  const HARD_SKIP_RX = getHardSkipRegexesFromConfig(cp);
  for (const bn of names) {
    const full = path.join(FIX_INPUT_DIR, bn);
    const rel = path.basename(bn).replace(/\\/g, '/'); // 병합 루트 1-depth 전제
    const rule = measureBlock('match-rule-for-path-template-integration', () => matchRuleForPath(rel, cp));
    if (!rule) {
      // 템플릿 대상이 아닌 로그면 건너뜀(테스트 입력에 따라 존재 가능)
      continue;
    }

    // 프리플라이트 기대값 계산: hard-skip + 매치율
    const sample = readFirstLines(full, cp.preflight.sample_lines ?? 200);
    const hardSkip = sample.some((ln) => HARD_SKIP_RX.some((rx) => rx.test(ln)));
    // 필수 필드 기준으로 매치율 계산
    const need = cp.requirements?.fields ?? { time: true, process: true, message: true };
    let okCnt = 0;
    for (const ln of sample) {
      const f = measureBlock('extract-by-compiled-rule-template-integration', () => extractByCompiledRule(ln, rule));
      const okTime = need.time ? !!f.time : true;
      const okProc = need.process ? !!f.process : true;
      const okMsg  = need.message ? !!f.message : true;
      if (okTime && okProc && okMsg) okCnt++;
    }
    const ratio = sample.length ? okCnt / sample.length : 0;
    const expected =
      !hardSkip && ratio >= (cp.preflight.min_match_ratio ?? 0.8);

    const ok = await measureBlock('should-use-parser-for-file-template-integration', () =>
      shouldUseParserForFile(full, rel, cp)
    );
    expect(ok).toBe(expected);
  }
});

it('설정대로 각 라인을 파싱하고, 파일별로 parsed_item/parsed_{파일명}.json 을 생성한다', async () => {
  const tpl = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  const cp = measureBlock('compile-parser-config-template-integration-second', () => compileParserConfig(tpl))!;

  const names = fs
    .readdirSync(FIX_INPUT_DIR)
    .filter((n) => /\.log(\.\d+)?$/i.test(n))
    .sort();
  expect(names.length).toBeGreaterThan(0);

  const artifacts: string[] = [];

  const HARD_SKIP_RX = getHardSkipRegexesFromConfig(cp);
  for (const bn of names) {
    const full = path.join(FIX_INPUT_DIR, bn);
    const rel = path.basename(bn).replace(/\\/g, '/');
    const rule = measureBlock('match-rule-for-path-template-integration-second', () => matchRuleForPath(rel, cp));
    if (!rule) continue; // 템플릿 대상 아님

    const sample = readFirstLines(full, cp.preflight.sample_lines ?? 200);
    // 하드 스킵 파일은 제외
    const hardSkip = sample.some((ln) => HARD_SKIP_RX.some((rx) => rx.test(ln)));
    if (hardSkip) continue;

    const need = cp.requirements?.fields ?? { time: true, process: true, message: true };
    const parsed = sample
      .map((ln) => measureBlock('extract-by-compiled-rule-template-integration-second', () => extractByCompiledRule(ln, rule)))
      .filter((f) => {
        const okTime = need.time ? !!f.time : true;
        const okProc = need.process ? !!f.process : true;
        const okMsg  = need.message ? !!f.message : true;
        return okTime && okProc && okMsg;
      })
      .map((f) => ({
        time: f.time ?? null,
        process: f.process ?? null,
        pid: f.pid ?? null,
        message: f.message ?? null,
      }));

    // 매치율이 템플릿 요구치(min_match_ratio) 이상이어야 함
    const ratio = sample.length ? parsed.length / sample.length : 0;
    expect(ratio).toBeGreaterThanOrEqual(cp.preflight.min_match_ratio ?? 0.8);

    // 산출물 저장(리포 루트/parsed_item/parsed_{파일명}.json)
    const outPath = path.join(PARSED_OUT_DIR, `parsed_${path.basename(rel)}.json`);
    fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2), 'utf8');
    artifacts.push(path.basename(outPath));
  }

  // 수동 검증 위치 안내
  if (artifacts.length) {
    console.log(
      `\n📦 Parsed artifacts written to: ${PARSED_OUT_DIR}\n` +
        artifacts.map((n) => ` - ${n}`).join('\n'),
    );
  }
});
