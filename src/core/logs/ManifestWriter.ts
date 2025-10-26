// === src/core/logs/ManifestWriter.ts ===
import * as fs from 'fs';
import * as path from 'path';

import { measure } from '../logging/perf.js';
import type { LogChunkMeta, LogManifest } from './ManifestTypes.js';
import { isLogManifest } from './ManifestTypes.js';

export class ManifestWriter {
  private manifest: LogManifest;
  private manifestPath: string;

  constructor(
    private outDir: string,
    initial?: Partial<LogManifest>,
  ) {
    this.manifestPath = path.join(outDir, 'manifest.json');
    this.manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      mergedLines: 0,
      chunkCount: 0,
      chunks: [],
      ...initial,
    } as LogManifest;
  }

  @measure()
  static async loadOrCreate(outDir: string): Promise<ManifestWriter> {
    const mf = path.join(outDir, 'manifest.json');
    try {
      const buf = await fs.promises.readFile(mf, 'utf8');
      const json = JSON.parse(buf);
      if (isLogManifest(json)) {
        // 기존 파일을 그대로 사용하되, 정합성 보완(정렬/카운트 재계산)
        const w = new ManifestWriter(outDir, json);
        // 유효하지 않은 청크 정리(file 비었거나 lines<=0)
        w.manifest.chunks = (w.manifest.chunks || []).filter(
          (c) => c && typeof c.file === 'string' && c.file.trim() && typeof c.lines === 'number' && c.lines > 0,
        );
        // start 기준으로 정렬(보장되지 않은 경우를 대비)
        w.manifest.chunks.sort((a, b) => a.start - b.start);
        w.manifest.chunkCount = w.manifest.chunks.length;
        // mergedLines 재계산(마지막 청크의 끝)
        if (w.manifest.chunkCount > 0) {
          const last = w.manifest.chunks[w.manifest.chunkCount - 1];
          w.manifest.mergedLines = last.start + last.lines;
        } else {
          w.manifest.mergedLines = 0;
        }
        // totalLines(힌트치)가 실제 mergedLines보다 작은 경우, 최소한 mergedLines로 상향
        if (
          typeof (w.manifest as any).totalLines === 'number' &&
          (w.manifest as any).totalLines < w.manifest.mergedLines
        ) {
          (w.manifest as any).totalLines = w.manifest.mergedLines;
        }
        return w;
      }
    } catch {}
    await fs.promises.mkdir(outDir, { recursive: true });
    return new ManifestWriter(outDir);
  }

  get path() {
    return this.manifestPath;
  }

  get data(): Readonly<LogManifest> {
    return this.manifest;
  }

  setTotal(total?: number) {
    if (typeof total === 'number') this.manifest.totalLines = total;
  }

  @measure()
  addChunk(file: string, lines: number, start: number) {
    // 안전장치: 잘못된 청크는 무시
    if (!file || !file.trim() || !(lines > 0)) return;
    if (!(start >= 0)) start = 0;
    const meta: LogChunkMeta = { file, lines, start };
    this.manifest.chunks.push(meta);
    this.manifest.chunks.sort((a, b) => a.start - b.start);
    this.manifest.chunkCount = this.manifest.chunks.length;
    // 마지막 청크 기준으로 mergedLines 갱신
    const last = this.manifest.chunks[this.manifest.chunkCount - 1];
    this.manifest.mergedLines = last.start + last.lines;
  }

  @measure()
  async save() {
    await fs.promises.mkdir(this.outDir, { recursive: true });
    const txt = JSON.stringify(this.manifest, null, 2);
    // 🔒 원자적 저장: 임시 파일에 쓴 뒤 rename
    const tmp = path.join(
      this.outDir,
      `manifest.json.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await fs.promises.writeFile(tmp, txt, 'utf8');
    try {
      await fs.promises.rename(tmp, this.manifestPath);
    } catch (e) {
      // rename 실패 시(드물게 Windows 등) 최후 수단으로 직접 overwrite 후 tmp 정리
      try {
        await fs.promises.writeFile(this.manifestPath, txt, 'utf8');
      } finally {
        try {
          await fs.promises.unlink(tmp);
        } catch {}
      }
    }
  }
}

/**
 * manifest에 기록된 청크 파일명에서 마지막 part 번호를 추출해
 * 다음에 쓸 파트 인덱스(0-based, 내부 카운터용)를 계산한다.
 * - ChunkWriter는 내부적으로 (currentIndex + 1)을 파일명에 사용하므로
 *   여기서 반환하는 값은 "마지막 번호 그대로"여야 한다.
 */
export function nextPartIndexFrom(manifest: Readonly<LogManifest>): number {
  const lastNum = (manifest?.chunks ?? [])
    .map((c) => {
      const m = c.file?.match(/part-(\d+)\.ndjson$/i);
      return m ? parseInt(m[1], 10) : 0;
    })
    .reduce((a, b) => Math.max(a, b), 0);
  return lastNum; // ← ChunkWriter는 +1 해서 파일명 생성
}
