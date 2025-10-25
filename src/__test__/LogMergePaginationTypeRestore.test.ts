// src/__test__/LogMergePaginationTypeRestore.test.ts

import type { LogEntry } from '@ipc/messages';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

import { ChunkWriter } from '../core/logs/ChunkWriter.js';
import { mergeDirectory } from '../core/logs/LogFileIntegration.js';
import { ManifestWriter } from '../core/logs/ManifestWriter.js';
import { PagedReader } from '../core/logs/PagedReader.js';
import { paginationService } from '../core/logs/PaginationService.js';
import type { ParserConfig } from '../core/logs/ParserEngine.js';
import {
  compileParserConfig,
  extractByCompiledRule,
  matchRuleForPath,
  shouldUseParserForFile,
} from '../core/logs/ParserEngine.js';
import { MERGED_CHUNK_MAX_LINES } from '../shared/const.js';
// 🔁 테스트 FS 헬퍼: 고정 out 루트 하위에 유니크 디렉터리 생성/삭제
import { cleanDir, prepareUniqueOutDir } from './helpers/testFs.js';

jest.setTimeout(120_000);

// ── 경로 상수 ───────────────────────────────────────────────────────────
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEST_LOG_DIR = path.join(REPO_ROOT, '.test_log');
const PARSER_TEMPLATE_PATH = path.join(
  REPO_ROOT,
  'media',
  'resources',
  'custom_log_parser.template.v1.json',
);

// ── 유틸(비교 안정화) ──────────────────────────────────────────────────
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]/g;
function stripAnsi(s: string) {
  return s.replace(ANSI_RE, '');
}
function normalizeForCompare(line: string): string {
  return stripAnsi(line)
    .replace(/[ \t]+/g, ' ')
    .trim();
}
function normalizeNewlines(s: string) {
  return s.replace(/\r\n/g, '\n');
}

// BOM 무시: 원본 vs 재구성 비교 시 U+FEFF 존재 여부는 의미 없으므로 제거
function stripBomAll(s: string) {
  return s.replace(/\uFEFF/g, '');
}

// ✅ 테스트에서만 사용할 "프로세스명 → 복원 대상 파일명" 매핑
//   - 이 목록에 포함된 것들만 복원 및 원본 대조를 수행한다.
const PROC_TO_FILE: Record<string, string> = {
  'homey-matter': 'matter.log',
  'homey-z3gateway': 'z3gateway.log',
  kernel: 'kernel.log',
  'homey-pro': 'homey-pro.log',
  cpcd: 'cpcd.log',
};
const FILE_BASES_OF_INTEREST = new Set(
  Object.values(PROC_TO_FILE).map((n) => n.replace(/\.log$/i, '')),
);

/** 파일명 정규화: PID 등 대괄호 태그 제거, 공백/대소문자/구분자 통일 */
function canonicalizeProcName(name: string) {
  return name
    .replace(/\[[^\]]*\]/g, '') // [1863], [4413] 등 제거
    .replace(/\s+/g, '') // 공백 제거
    .replace(/[_]+/g, '-') // _ → - 통일(선택)
    .toLowerCase();
}

/** REBUILT_DIR 내에서 proc에 해당하는 복원본 로그 실제 경로를 탐색 */
function resolveRebuiltPath(proc: string, rebuiltDir: string) {
  const direct = path.join(rebuiltDir, `${proc}.log`);
  if (fs.existsSync(direct)) return direct;
  try {
    const files = fs.readdirSync(rebuiltDir).filter((f) => f.toLowerCase().endsWith('.log'));
    const target = canonicalizeProcName(proc);
    const hit = files.find((f) => canonicalizeProcName(path.basename(f, '.log')) === target);
    if (hit) return path.join(rebuiltDir, hit);
    // prefix 매치도 한 번 더 시도 (예: homey-matter vs homey-matter-xyz)
    const prefix = files.find((f) =>
      canonicalizeProcName(path.basename(f, '.log')).startsWith(target),
    );
    if (prefix) return path.join(rebuiltDir, prefix);
    // 못 찾으면 디버깅 편의로 목록 로그 출력
    // (jest 실행 시 콘솔에 경고로 남김)

    console.warn(`[resolveRebuiltPath] Not found for "${proc}". Candidates: ${files.join(', ')}`);
  } catch {}
  return direct;
}

/** e.text 또는 parsed에서 process명 추출 */
function extractProcess(e: LogEntry): string | undefined {
  const p = (e as any)?.parsed?.process;
  if (p && String(p).trim()) return String(p).trim();
  const t = String(e.text || '');
  // ‘[’은 문자 클래스 내부에서 이스케이프가 불필요하므로 제거
  const m = t.match(/^\[[^\]]+\]\s+([^\s:[]+)(?:\[\d+\])?:/);
  return m ? m[1] : undefined;
}

/** .test_log 밑의 기준 원본(log 회전본 제외, *.log 만) */
function listOriginalLogFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const names = fs.readdirSync(dir);
  for (const n of names) {
    if (!/\.log$/i.test(n)) continue; // *.log 만
    if (/\.log\.\d+$/i.test(n)) continue; // 회전본 제외
    out.set(n.replace(/\.log$/i, ''), path.join(dir, n));
  }
  return out;
}

/** 오름차순으로 반환되었는지 간단 검증 */
function expectAscByTs(rows: LogEntry[]) {
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i].ts).toBeGreaterThanOrEqual(rows[i - 1].ts);
  }
}

// ── 테스트 본문 ────────────────────────────────────────────────────────
describe('파일 병합 → Pagination 오름차순 → 타입별 복원 → 원본 대조', () => {
  it('config 기반 실제 병합 결과로 roundtrip 복원 검증', async () => {
    // 사전 조건
    if (!fs.existsSync(TEST_LOG_DIR)) {
      throw new Error(`Missing test logs: ${TEST_LOG_DIR}`);
    }
    const parserConfig: ParserConfig = JSON.parse(fs.readFileSync(PARSER_TEMPLATE_PATH, 'utf8'));
    const compiled = compileParserConfig(parserConfig)!;

    // 0) 테스트 전용 작업 디렉터리 (helpers/testFs 사용)
    const workDir = prepareUniqueOutDir('merge-pagination-restore');

    try {
      // 1) 실제 프로젝트 로직만으로 병합 실행
      //    - mergeDirectory의 onBatch 스트림을 ChunkWriter+ManifestWriter로 받아서 NDJSON 청크/manifest 저장
      const MANIFEST_DIR = path.join(workDir, 'manifest');
      await fsp.mkdir(MANIFEST_DIR, { recursive: true });
      const chunkWriter = new ChunkWriter(MANIFEST_DIR, MERGED_CHUNK_MAX_LINES);
      const manifest = await ManifestWriter.loadOrCreate(MANIFEST_DIR);

      // 📌 중간 산출물(타입별 jsonl 등)을 src/__test__/out/... 하위로 강제
      const INTERMEDIATE_DIR = path.join(workDir, 't1_merged');
      const RAW_DIR = path.join(workDir, 't1_raw'); // 필요 없으면 사용 안 해도 됨
      await fsp.mkdir(INTERMEDIATE_DIR, { recursive: true }).catch(() => {});
      await fsp.mkdir(RAW_DIR, { recursive: true }).catch(() => {});

      let merged = 0;

      // 타입 선언과의 충돌을 피하기 위해 옵션 객체에 한 번 any 캐스팅
      const mergeOpts: any = {
        dir: TEST_LOG_DIR,
        parser: parserConfig,
        preserveFullText: true, // 헤더 복원(원문 포맷 확보)
        batchSize: 200,
        // ✅ 기본값(.test_log/merged)을 사용하지 않고 out 하위로 보냄
        mergedDirPath: INTERMEDIATE_DIR,
        rawDirPath: RAW_DIR,
        onBatch: async (logs: LogEntry[]) => {
          const made = await chunkWriter.appendBatch(logs);
          for (const c of made) {
            manifest.addChunk(c.file, c.lines, merged);
            merged += c.lines;
          }
        },
      };

      await mergeDirectory(mergeOpts);

      const rem = await chunkWriter.flushRemainder();
      if (rem) {
        manifest.addChunk(rem.file, rem.lines, merged);
        merged += rem.lines;
      }
      manifest.setTotal(merged);
      await manifest.save();
      expect(merged).toBeGreaterThan(0);

      // 2) PaginationService로 “오름차순” 반환 확인
      await paginationService.setManifestDir(MANIFEST_DIR);
      await paginationService.reload(); // 파일 기반으로 전환
      const total = paginationService.getFileTotal() ?? 0;
      expect(total).toBe(merged);

      const first = await paginationService.readRangeByIdx(1, Math.min(50, total));
      expectAscByTs(first);

      if (total > 200) {
        const mid = Math.floor(total / 2);
        const midRows = await paginationService.readRangeByIdx(mid - 25, mid + 25);
        expectAscByTs(midRows);
      }

      const tailRows = await paginationService.readRangeByIdx(Math.max(1, total - 49), total);
      expectAscByTs(tailRows);

      // 3) (테스트 구현) 최종 병합된 로그를 “맨 아래줄부터 위로” 읽어 타입별 파일로 복원
      const reader = await PagedReader.open(MANIFEST_DIR);
      const totalLines = reader.getTotalLines() ?? 0;
      const allDesc = await reader.readLineRange(0, totalLines, {
        skipInvalid: true,
      });

      // .test_log 내 원본 중, 매핑 대상에 해당하는 파일만 고른다.
      const originalsAll = listOriginalLogFiles(TEST_LOG_DIR); // Map<fileBase, filePath>
      const originals = new Map(
        [...originalsAll].filter(([base]) => FILE_BASES_OF_INTEREST.has(base)),
      );
      expect(originals.size).toBeGreaterThan(0);

      const REBUILT_DIR = path.join(workDir, 'rebuilt_by_process');
      await fsp.mkdir(REBUILT_DIR, { recursive: true });

      // 프로세스명 → 실제 쓰기 대상 파일 경로 매핑 구성
      const targetsByProc = new Map<string, string>();
      for (const [procName, fileName] of Object.entries(PROC_TO_FILE)) {
        const base = fileName.replace(/\.log$/i, '');
        if (originals.has(base)) {
          targetsByProc.set(procName, path.join(REBUILT_DIR, fileName));
        }
      }
      const targetProcs = new Set(targetsByProc.keys());

      // 맨 아래줄(가장 오래된)부터 위로 → 매핑된 파일에만 append
      for (let i = allDesc.length - 1; i >= 0; i--) {
        const e = allDesc[i] as LogEntry;
        const proc = extractProcess(e);
        if (!proc || !targetProcs.has(proc)) continue;
        const outPath = targetsByProc.get(proc)!;
        await fsp.appendFile(outPath, String(e.text ?? '') + '\n', 'utf8');
      }

      // 4) 복원본 vs 원본 라인-바이-라인 비교
      for (const [fileBase, origPath] of originals) {
        const rebuiltPath = resolveRebuiltPath(fileBase, REBUILT_DIR);
        const original = stripBomAll(normalizeNewlines(fs.readFileSync(origPath, 'utf8')));
        let rebuilt = '';
        if (fs.existsSync(rebuiltPath)) {
          rebuilt = stripBomAll(normalizeNewlines(fs.readFileSync(rebuiltPath, 'utf8')));
        } else {
          console.warn(
            `[compare] rebuilt log not found for "${fileBase}" → expected at: ${rebuiltPath}`,
          );
        }

        const origLines = original.split('\n');
        const rebLines = rebuilt.split('\n');
        if (origLines.length && origLines[origLines.length - 1] === '') origLines.pop();
        if (rebLines.length && rebLines[rebLines.length - 1] === '') rebLines.pop();

        // === 실제 파이프라인의 "드랍 규칙"을 기대값에 반영 ===
        // 1) 이 파일에 파서가 적용되는지 프리플라이트로 확인
        const baseName = path.basename(origPath).replace(/\\/g, '/');
        const useParser = await shouldUseParserForFile(origPath, baseName, compiled);
        const rule = matchRuleForPath(baseName, compiled);

        // 2) 비교 대상에서 제외해야 할 라인 필터링
        //   - 빈 줄("") → 리더 단계에서 드랍
        //   - (파서 적용 파일 && time/process/pid 셋 모두 없음) → 파서 게이트에서 드랍
        const origLinesAfterDrop = origLines.filter((line) => {
          if (line === '') return false; // 빈 줄은 항상 제외
          if (!useParser || !rule) return true;
          const f = extractByCompiledRule(line, rule);
          const hasTime = !!(f.time && String(f.time).trim());
          const hasProc = !!(f.process && String(f.process).trim());
          const pidRaw = f.pid;
          const hasPid = !(pidRaw === undefined || pidRaw === null || String(pidRaw).trim() === '');
          return hasTime || hasProc || hasPid;
        });

        // ANSI 및 공백 차이는 무시(프로젝트 로직이 ANSI를 정규화할 수 있음)
        const normOrig = origLinesAfterDrop.map(normalizeForCompare);
        const normReb = rebLines.map(normalizeForCompare);

        expect(normReb).toEqual(normOrig);
      }
    } finally {
      // 🔚 테스트 산출물 정리 (디버깅을 위해 기본은 보존)
      try {
        if (workDir && fs.existsSync(workDir)) cleanDir(workDir);
      } catch {}
    }
  });
});
