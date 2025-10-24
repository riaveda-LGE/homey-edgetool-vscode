// src/__test__/LogFieldExtractionGolden.test.ts
// 기존 "roundtrip reconstruction" 테스트를 제거하고
// 병합 완료 버퍼(내림차순 저장) → paginationService 매핑(오름차순) 검증으로 교체

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ManifestWriter } from '../core/logs/ManifestWriter.js';
import { paginationService } from '../core/logs/PaginationService.js';
import { LOG_WINDOW_SIZE } from '../shared/const.js';

jest.setTimeout(120_000);

/**
 * 테스트 개요
 * 1) 임시 폴더에 manifest.json + part-*.ndjson 청크들을 생성한다.
 *    - 전체 라인 수: total = 600
 *    - 청크: 4개, 각 150 라인
 *    - 물리 저장 순서: **내림차순**(최신→오래된)로 저장
 *      · 물리 인덱스 i(0..total-1) 에 대해 ts는 큰→작은 순으로 감소
 *      · 오름차순 논리 idx(과거=1, 최신=total)는 (total - i)
 *      · text는 `[time] proc[999]: message #<idx>` 형식으로 작성
 * 2) paginationService.setManifestDir(tmp)로 파일 기반 모드로 연다.
 * 3) 스크롤 50% 위치를 기준으로 LOG_WINDOW_SIZE만큼 범위를 요청한다.
 *    - startIdx = floor(total*0.5) - floor(W/2) + 1
 *    - endIdx   = startIdx + W - 1
 * 4) 반환된 로그가
 *    (a) 길이 W,
 *    (b) idx가 startIdx..endIdx로 연속,
 *    (c) text 내 "#<idx>"가 idx와 일치,
 *    (d) ts가 **오름차순(idx asc ⇒ 시간 증가)** 으로 정렬
 *    을 모두 만족하는지 검증한다.
 */

describe('Pagination mapping at 50% scroll (desc buffer → asc page)', () => {
  const total = 600;
  const chunk = 150; // 4 chunks
  const chunks = Math.ceil(total / chunk);
  const windowSize = LOG_WINDOW_SIZE; // 200
  const center = Math.floor(total * 0.5); // 300
  const startIdx = Math.max(1, center - Math.floor(windowSize / 2) + 1); // 201
  const endIdx = Math.min(total, startIdx + windowSize - 1);             // 400

  // 물리 i(0..total-1) → 논리 오름차순 idx(1..total)
  const ascIdxFromPhys = (i: number) => total - i;

  // asc idx → ISO 시간 문자열 (idx 오름차순일수록 시간이 증가하도록)
  const isoFromAscIdx = (idx: number) => {
    const t0 = Date.parse('2024-01-01T00:00:00.000Z');
    const ts = t0 + (idx - 1); // 1ms 간격으로 단조 증가
    return new Date(ts).toISOString();
  };

  // 임시 작업 폴더
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-paging-'));
    const mf = await ManifestWriter.loadOrCreate(tmpDir);

    let globalStart = 0;
    for (let part = 0; part < chunks; part++) {
      const partName = `part-${String(part + 1).padStart(6, '0')}.ndjson`;
      const linesThis = Math.min(chunk, total - globalStart);
      const filePath = path.join(tmpDir, partName);

      const lines: string[] = [];
      // 물리 저장은 전역적으로 **내림차순(ts desc)** 이어야 한다.
      // 전역 물리 i는 0..total-1, i가 증가할수록 **오래된** 로그.
      for (let k = 0; k < linesThis; k++) {
        const i = globalStart + k;          // 전역 물리 인덱스
        const ascIdx = ascIdxFromPhys(i);   // 논리 오름차순 인덱스(과거=1, 최신=total)
        const iso = isoFromAscIdx(ascIdx);  // idx가 클수록 시간이 큼(=최신)
        const text = `[${iso}] proc[999]: message #${ascIdx}`;

        const entry = {
          ts: Date.parse(iso),
          text,
          file: 'synthetic.log',
          path: 'synthetic.log',
          level: 'I',
          type: 'other',
        };
        lines.push(JSON.stringify(entry));
      }

      fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
      mf.addChunk(partName, linesThis, globalStart);
      globalStart += linesThis;
    }

    // 총계는 없어도 되지만 있으면 PagedReader.getTotalLines()가 더 직관적으로 동작
    mf.setTotal(total);
    await mf.save();

    // 파일 기반 모드로 open
    await paginationService.setManifestDir(tmpDir);
    paginationService.clearFilter(); // 필터 해제 보장
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('maps correctly from physical(desc) to logical(asc) and preserves idx/time/text', async () => {
    // 요청: 50% 지점(센터) 기준의 페이지
    const rows = await paginationService.readRangeByIdx(startIdx, endIdx);

    // (a) 길이
    expect(rows.length).toBe(endIdx - startIdx + 1);

    // (b) idx 연속성 & (c) 텍스트 내 #idx 일치 & (d) ts 오름차순
    let lastTs = Number.NEGATIVE_INFINITY;
    for (let j = 0; j < rows.length; j++) {
      const r: any = rows[j];
      const expectedIdx = startIdx + j;

      // idx가 연속(논리 오름차순)
      expect(r.idx).toBe(expectedIdx);

      // 메시지 본문이 웹뷰어에 그대로 출력 가능한지: "#<idx>" 포함 여부로 확인
      const m = String(r.text || '').match(/#(\d+)\b/);
      expect(m).toBeTruthy();
      expect(Number(m![1])).toBe(expectedIdx);

      // 시간 증가(오름차순)
      expect(typeof r.ts).toBe('number');
      expect(r.ts).toBeGreaterThan(lastTs);
      lastTs = r.ts;
    }

    // 추가 안전망: 첫/끝 라인의 시간/문구를 한 번 더 직관적으로 체크
    const first = rows[0] as any;
    const last = rows[rows.length - 1] as any;
    expect(first.text).toContain(`#${startIdx}`);
    expect(last.text).toContain(`#${endIdx}`);
    expect(last.ts).toBeGreaterThan(first.ts);
  });
});