// === src/core/logs/ChunkWriter.ts ===
import * as fs from 'fs';
import * as path from 'path';

import type { LogEntry } from '@ipc/messages';

export type ChunkWriteResult = {
  /** 새로 만들어진 파일명(상대) */
  file: string;
  /** 이 파일에 기록된 라인 수 */
  lines: number;
};

export class ChunkWriter {
  private currentIndex = 0;
  private currentBuffer: LogEntry[] = [];
  private writtenThisChunk = 0;

  constructor(
    private outDir: string,
    private chunkMaxLines: number,
    startIndex = 0, // part-XXXX 시작 인덱스(0-based)
  ) {
    this.currentIndex = startIndex;
  }

  /** 들어온 엔트리들을 청크 경계에 맞춰 파일로 기록하고, 생성/완성된 part 목록을 반환 */
  async appendBatch(entries: LogEntry[]): Promise<ChunkWriteResult[]> {
    const results: ChunkWriteResult[] = [];
    for (const e of entries) {
      this.currentBuffer.push(e);
      this.writtenThisChunk++;
      if (this.writtenThisChunk >= this.chunkMaxLines) {
        const r = await this.flushChunk();
        results.push(r);
      }
    }
    return results;
  }

  /** 강제 플러시(미완 청크까지 파일로 떨어뜨림) */
  async flushRemainder(): Promise<ChunkWriteResult | undefined> {
    if (!this.currentBuffer.length) return;
    return await this.flushChunk();
  }

  private async flushChunk(): Promise<ChunkWriteResult> {
    const partName = `part-${String(this.currentIndex + 1).padStart(6, '0')}.ndjson`;
    const filePath = path.join(this.outDir, partName);

    const text = this.currentBuffer.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fs.promises.mkdir(this.outDir, { recursive: true });
    await fs.promises.writeFile(filePath, text, 'utf8');

    const lines = this.currentBuffer.length;
    this.currentBuffer = [];
    this.writtenThisChunk = 0;
    this.currentIndex += 1;

    return { file: partName, lines };
  }
}
