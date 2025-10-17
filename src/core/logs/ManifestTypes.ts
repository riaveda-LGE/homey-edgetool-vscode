// === src/core/logs/ManifestTypes.ts ===

export type LogChunkMeta = {
  /** 청크 파일명 (상대 경로, 예: "part-000001.ndjson") */
  file: string;
  /** 이 청크가 포함하는 라인(엔트리) 수 */
  lines: number;
  /** 병합 전체 기준의 시작 라인 인덱스(0-based) */
  start: number;
};

export type LogManifest = {
  /** 스키마 버전 */
  version: 1;
  /** 작성 시각 ISO */
  createdAt: string;
  /** 전체 라인 수(알려져 있으면), 모르면 undefined */
  totalLines?: number;
  /** 현재까지 병합/저장된 라인 수 */
  mergedLines: number;
  /** 청크 개수 */
  chunkCount: number;
  /** 청크 메타 목록 (시간순/소트된 순서) */
  chunks: LogChunkMeta[];
};

export function isLogManifest(x: unknown): x is LogManifest {
  if (!x || typeof x !== 'object') return false;
  const m = x as any;
  return (
    m.version === 1 &&
    typeof m.createdAt === 'string' &&
    typeof m.mergedLines === 'number' &&
    typeof m.chunkCount === 'number' &&
    Array.isArray(m.chunks)
  );
}
