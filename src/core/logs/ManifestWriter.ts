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
    await fs.promises.writeFile(this.manifestPath, txt, 'utf8');
  }
}
