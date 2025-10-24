// === src/__test__/LogPipelineE2E.test.ts ===
// 목적: 실제 파서 설정(custom_log_parser.json) → 병합(mergeDirectory) → 스크롤 페이징(paginationService)
// 까지 "하나의 테스트"에서 연속으로 검증하는 E2E.

import * as fs from 'fs';
import * as path from 'path';

import {
  compileParserConfig,
  shouldUseParserForFile,
  matchRuleForPath,
} from '../core/logs/ParserEngine.js';
import { mergeDirectory } from '../core/logs/LogFileIntegration.js';
import { ManifestWriter } from '../core/logs/ManifestWriter.js';
import { paginationService } from '../core/logs/PaginationService.js';
import { LOG_WINDOW_SIZE } from '../shared/const.js';
import {
  cleanAndEnsureDir,
  cleanDir,
  prepareUniqueOutDir,
  drainNextTicks,
} from './helpers/testFs.js';
import type { LogEntry } from '../shared/ipc/messages.js';
import { measureBlock } from '../core/logging/perf.js';

jest.setTimeout(600_000);

describe('E2E: custom_log_parser → mergeDirectory(desc) → paginationService(asc)', () => {
  const REPO_ROOT = path.resolve(__dirname, '..', '..');
  const INPUT_DIR = path.resolve(
    __dirname,
    'test_log',
    'normal_test_suite',
    'before_merge',
  );
  const PARSER_CONFIG_PATH = path.resolve(
    REPO_ROOT,
    'media',
    'resources',
    'custom_log_parser.template.v1.json',
  );

  let OUT_DIR: string;
  let MANIFEST_DIR: string;

  beforeEach(() => {
    OUT_DIR = prepareUniqueOutDir('pipeline-e2e');
    MANIFEST_DIR = path.join(OUT_DIR, 'manifest');
    cleanAndEnsureDir(OUT_DIR);
    cleanAndEnsureDir(MANIFEST_DIR);
  });

  afterEach(() => {
    cleanDir(OUT_DIR);
  });

  it('파싱 프리플라이트 → 병합(desc) → 웹뷰 페이징(asc) 순으로 일관성 검증', async () => {
    // 1) 실제 파서 설정 로드 및 컴파일
    const parserJson = JSON.parse(fs.readFileSync(PARSER_CONFIG_PATH, 'utf8'));
    const cp = measureBlock('compile-parser-config-pipeline', () => compileParserConfig(parserJson))!;
    expect(cp).toBeTruthy();
    expect(cp.version).toBe(1);

    // 2) 프리플라이트: 각 입력 파일에 대해 shouldUseParserForFile == true (템플릿/룰 매칭)
    const names = fs
      .readdirSync(INPUT_DIR)
      .filter((n) => /\.log(\.\d+)?$/i.test(n))
      .sort();
    expect(names.length).toBeGreaterThan(0);

    for (const bn of names) {
      const full = path.join(INPUT_DIR, bn);
      const rel = path.basename(bn).replace(/\\/g, '/');
      const rule = measureBlock('match-rule-for-path-pipeline', () => matchRuleForPath(rel, cp));
      if (!rule) continue; // 대상이 아닌 파일은 스킵
      const ok = await measureBlock('should-use-parser-for-file-pipeline', () =>
        shouldUseParserForFile(full, rel, cp),
      );
      expect(ok).toBe(true);
    }

    // 3) 병합: 실제 로직으로 desc(최신→오래된) 배출
    const mergedDir = path.join(OUT_DIR, 'merged_raw_jsonl');
    cleanAndEnsureDir(mergedDir);
    const merged: LogEntry[] = [];
    await measureBlock('merge-directory-pipeline', () =>
      mergeDirectory({
        dir: INPUT_DIR,
        mergedDirPath: mergedDir,
        parser: parserJson,           // 실제 설정 사용(내부에서 컴파일)
        preserveFullText: true,
        batchSize: 1000,
        onBatch: (logs) => { merged.push(...logs); },
      }),
    );
    await drainNextTicks();
    expect(merged.length).toBeGreaterThan(0);

    // 4) manifest 생성: desc 물리 버퍼를 그대로 파트로 쪼개서 저장 (part-*.ndjson)
    const mf = await ManifestWriter.loadOrCreate(MANIFEST_DIR);
    const total = merged.length;
    const PART_SIZE = 150; // 물리 파일 단위 (임의 고정값, PaginationService는 manifest만 따르면 OK)

    let globalStart = 0;
    let partIdx = 0;
    for (let i = 0; i < total; i += PART_SIZE) {
      const slice = merged.slice(i, Math.min(total, i + PART_SIZE));
      const fname = `part-${String(++partIdx).padStart(6, '0')}.ndjson`;
      const fp = path.join(MANIFEST_DIR, fname);
      const lines = slice.map((e) =>
        JSON.stringify({
          ts: e.ts,
          text: e.text,
          file: e.file || 'unknown.log',
          path: e.file || 'unknown.log',
          level: e.level || 'I',
          type: e.type || 'other',
        }),
      );
      fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf8');
      mf.addChunk(fname, slice.length, globalStart);
      globalStart += slice.length;
    }
    mf.setTotal(total);
    await mf.save();

    // 5) paginationService로 읽기: desc 물리를 asc(idx) 페이지로 정확히 맵핑되는지
    await paginationService.setManifestDir(MANIFEST_DIR);
    paginationService.clearFilter();

    const windowSize = LOG_WINDOW_SIZE; // 보통 200
    const center = Math.floor(total * 0.5);
    const startIdx = Math.max(1, center - Math.floor(windowSize / 2) + 1);
    const endIdx = Math.min(total, startIdx + windowSize - 1);

    const rows = await paginationService.readRangeByIdx(startIdx, endIdx);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(endIdx - startIdx + 1);

    // asc idx → 물리 desc 인덱스 변환
    const physFromAsc = (idx: number) => total - idx; // 0-based

    // 검증: (a) idx 연속성, (b) ts 오름차순(>=), (c) text 정합성
    let lastTs = Number.NEGATIVE_INFINITY;
    for (let j = 0; j < rows.length; j++) {
      const r: any = rows[j];
      const expectedIdx = startIdx + j;
      const phys = physFromAsc(expectedIdx);

      expect(r.idx).toBe(expectedIdx);
      expect(typeof r.ts).toBe('number');
      expect(r.text).toBe(merged[phys]?.text);
      expect(r.ts).toBeGreaterThanOrEqual(lastTs);
      lastTs = r.ts;
    }
  });
});
