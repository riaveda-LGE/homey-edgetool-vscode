import * as fs from 'fs';
import * as path from 'path';
import {
  compileWhitelistPathRegexes,
  pathMatchesWhitelist,
  listInputLogFiles,
} from '../core/logs/LogFileIntegration.js';
import { prepareUniqueOutDir, ensureDir, cleanDir } from './helpers/testFs.js';
import { measureBlock } from '../core/logging/perf.js';

jest.setTimeout(120_000);

let DIR: string;
beforeEach(() => {
  DIR = prepareUniqueOutDir('whitelist');
  ensureDir(DIR);
});
afterEach(() => cleanDir(DIR));

it('화이트리스트(베이스네임) 매칭과 비재귀 탐색 규칙을 지킨다', async () => {
  // 루트 파일
  fs.writeFileSync(path.join(DIR, 'kernel.log'), 'x\n', 'utf8');
  fs.writeFileSync(path.join(DIR, 'cpcd.log.1'), 'x\n', 'utf8');
  fs.writeFileSync(path.join(DIR, 'notes.txt'), 'x\n', 'utf8'); // 비로그 확장자
  // 하위 디렉터리(비재귀라 기본 walk에서 무시됨)
  fs.mkdirSync(path.join(DIR, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(DIR, 'nested', 'clip.log'), 'x\n', 'utf8');

  // 베이스네임 기준: '^'로 시작하면 정규식 토큰으로 해석됨
  const allow = measureBlock('compile-whitelist-path-regexes', () =>
    compileWhitelistPathRegexes([
      '^cpcd\\.log(\\..+)?$', // cpcd.log, cpcd.log.N
      '^notes\\.txt$',        // notes.txt
      '^clip\\.log$',         // clip.log (경로 넘겨도 내부에서 basename 추출)
    ])
  );

  // pathMatchesWhitelist는 내부적으로 basename을 사용하므로 경로를 넣어도 동일하게 판정
  expect(measureBlock('path-matches-whitelist-1', () => pathMatchesWhitelist('cpcd.log.1', allow))).toBe(true);
  expect(measureBlock('path-matches-whitelist-2', () => pathMatchesWhitelist('notes.txt', allow))).toBe(true);
  expect(measureBlock('path-matches-whitelist-3', () => pathMatchesWhitelist('nested/clip.log', allow))).toBe(true);
  expect(measureBlock('path-matches-whitelist-4', () => pathMatchesWhitelist('kernel.log', allow))).toBe(false);

  // 하지만 listInputLogFiles는 비재귀(root only)이므로 nested/clip.log는 수집되지 않는다.
  const listed = await measureBlock('list-input-log-files', () => listInputLogFiles(DIR, allow));
  expect(listed.sort()).toEqual(['cpcd.log.1', 'notes.txt']); // kernel.log는 allow 미매치
});