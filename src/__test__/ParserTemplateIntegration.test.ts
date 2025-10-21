// === src/__test__/ParserTemplateIntegration.test.ts ===
import * as fs from 'fs';
import * as path from 'path';

import {
  compileParserConfig,
  shouldUseParserForFile,
  matchRuleForPath,
  extractByCompiledRule,
} from '../core/logs/ParserEngine.js';
import {
  cleanDir,
  cleanAndEnsureDir,
  prepareUniqueOutDir,
} from './helpers/testFs.js';

jest.setTimeout(120_000);

let TEMP_DIR: string;
let INPUT_DIR: string;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PARSED_OUT_DIR = path.join(REPO_ROOT, 'parsed_item');

// 템플릿 경로(리포지토리 내 내장 템플릿)
const TEMPLATE_PATH = path.resolve(
  REPO_ROOT,
  'media',
  'resources',
  'custom_log_parser.template.v1.json',
);

function writeFileLines(filePath: string, lines: string[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

beforeEach(() => {
  TEMP_DIR = prepareUniqueOutDir('parser-it');
  INPUT_DIR = path.join(TEMP_DIR, 'input');
  cleanAndEnsureDir(INPUT_DIR);
  // 수동 확인용 산출물 폴더(리포지토리 루트) — 테스트가 지우지 않습니다.
  if (!fs.existsSync(PARSED_OUT_DIR)) fs.mkdirSync(PARSED_OUT_DIR, { recursive: true });
});

afterEach(() => {
  // temp 입력만 정리, parsed_item은 남겨둠(육안 검증용)
  cleanDir(TEMP_DIR);
});

it('템플릿이 정상 컴파일되고 요구/프리플라이트/글롭 매칭이 적용된다', async () => {
  const tpl = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  const cp = compileParserConfig(tpl)!;
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

  // 테스트 입력 파일들 생성
  const files = [
    {
      rel: 'kernel.log',
      lines: [
        '[Sep  5 09:10:11.123] kernel[111]: boot complete',
        '[Sep  5 09:10:12.456] kernel[111]: init driver',
        '[Sep  5 09:10:13.789] kernel: no pid case is also fine',
      ],
      shouldUse: true,
    },
    {
      rel: 'cpcd.log.1',
      lines: [
        '[Oct 12 14:00:00.001] cpcd[987]: starting...',
        '[Oct 12 14:00:01.002] cpcd[987]: ready',
      ],
      shouldUse: true,
    },
    {
      // 하드 스킵 패턴과 매치되는 라인을 섞어 shouldUse=false를 검증
      rel: 'system.log',
      lines: [
        'WIFI==> scanning', // hard_skip_if_any_line_matches 에 걸리도록 함
        '[Nov  2 01:02:03.004] systemd[1]: service started',
      ],
      shouldUse: false,
    },
    {
      // 별도 rule(files: ["**/bt_player.log*"]) 확인
      rel: 'bt_player.log',
      lines: [
        '[Dec 25 23:59:59.999] btplay[777]: merry xmas',
        '[Dec 26 00:00:00.000] btplay: new year!',
      ],
      shouldUse: true,
    },
  ];

  // 파일 작성
  for (const f of files) {
    writeFileLines(path.join(INPUT_DIR, f.rel), f.lines);
  }

  // shouldUseParserForFile 결과 확인
  for (const f of files) {
    const full = path.join(INPUT_DIR, f.rel);
    const rel = f.rel.replace(/\\/g, '/'); // 글롭 매칭은 상대경로로
    const ok = await shouldUseParserForFile(full, rel, cp);
    expect(ok).toBe(f.shouldUse);
  }

  // 하드 스킵된 파일(system.log)은 매칭 rule은 있어도 프리플라이트에서 제외되는 걸 확인
  const systemRule = matchRuleForPath('system.log', cp);
  expect(systemRule).toBeTruthy(); // 글롭은 맞지만…
  const systemShouldUse = await shouldUseParserForFile(
    path.join(INPUT_DIR, 'system.log'),
    'system.log',
    cp,
  );
  expect(systemShouldUse).toBe(false); // …프리플라이트에서 hard skip
});

it('설정대로 각 라인을 파싱하고, 파일별로 parsed_item/parsed_{파일명}.json 을 생성한다', async () => {
  const tpl = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  const cp = compileParserConfig(tpl)!;

  // 입력 파일 준비(하드스킵 파일은 제외)
  const cases = [
    {
      rel: 'kernel.log',
      lines: [
        '[Sep  5 09:10:11.123] kernel[111]: boot complete',
        '[Sep  5 09:10:12.456] kernel[111]: init driver',
        '[Sep  5 09:10:13.789] kernel: no pid case is also fine',
      ],
    },
    {
      rel: 'cpcd.log.1',
      lines: [
        '[Oct 12 14:00:00.001] cpcd[987]: starting...',
        '[Oct 12 14:00:01.002] cpcd[987]: ready',
      ],
    },
    {
      rel: 'bt_player.log',
      lines: [
        '[Dec 25 23:59:59.999] btplay[777]: merry xmas',
        '[Dec 26 00:00:00.000] btplay: new year!',
      ],
    },
  ];

  for (const c of cases) writeFileLines(path.join(INPUT_DIR, c.rel), c.lines);

  for (const c of cases) {
    const rel = c.rel.replace(/\\/g, '/');
    const rule = matchRuleForPath(rel, cp);
    expect(rule).toBeTruthy();

    const parsed = c.lines
      .filter((ln) => !!ln.trim())
      .map((line) => {
        const f = extractByCompiledRule(line, rule!);
        // 요구 필드 검증: time / process / message 는 필수
        expect(f.time).toBeTruthy();
        expect(f.process).toBeTruthy();
        expect(f.message).toBeTruthy();

        return {
          time: f.time ?? null,
          process: f.process ?? null,
          pid: f.pid ?? null,
          message: f.message ?? null,
        };
      });

    // 산출물 저장(리포 루트/parsed_item/parsed_{파일명}.json)
    const outPath = path.join(
      PARSED_OUT_DIR,
      `parsed_${path.basename(c.rel)}.json`,
    );
    fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2), 'utf8');

    // 간단 정합: 라인 수 == 객체 수
    expect(parsed.length).toBe(c.lines.length);
  }

  // 수동 검증 위치 안내(테스트가 이 경로에 파일을 남깁니다)
  console.log(
    `\n📦 Parsed artifacts written to: ${PARSED_OUT_DIR}\n` +
      cases
        .map((c) => ` - parsed_${path.basename(c.rel)}.json`)
        .join('\n'),
  );
});