// === src/core/logs/ChunkWriter.ts ===
import type { LogEntry } from '@ipc/messages';
import * as fs from 'fs';
import * as path from 'path';

import { measure } from '../logging/perf.js';

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
  /** 최초 flush 시 디렉터리에서 파트 인덱스를 한 번만 복구 */
  private fsIndexInitialized = false;
  /** 동시 flush 경쟁 방지용 직렬화 체인 */
  private _serial: Promise<any> = Promise.resolve();

  constructor(
    private outDir: string,
    private chunkMaxLines: number,
    startIndex = 0, // part-XXXX 시작 인덱스(0-based)
  ) {
    this.currentIndex = startIndex;
  }

  /** 들어온 엔트리들을 청크 경계에 맞춰 파일로 기록하고, 생성/완성된 part 목록을 반환 */
  @measure()
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
  @measure()
  async flushRemainder(): Promise<ChunkWriteResult | undefined> {
    if (!this.currentBuffer.length) return;
    const result = await this.flushChunk();
    return result;
  }

  @measure()
  private async flushChunk(): Promise<ChunkWriteResult> {
    const run = async (): Promise<ChunkWriteResult> => {
      // ── 1) 최초 한 번: 기존 디렉터리의 마지막 파트 번호로 인덱스 복구 ─────────────
      if (!this.fsIndexInitialized) {
        try {
          const names = await fs.promises.readdir(this.outDir).catch(() => [] as string[]);
          let maxIdx = this.currentIndex;
          for (const nm of names) {
            const m = nm.match(/^part-(\d{6})\.ndjson$/i);
            if (m) {
              const n = parseInt(m[1], 10);
              if (Number.isFinite(n)) maxIdx = Math.max(maxIdx, n);
            }
          }
          // currentIndex는 "마지막 사용한 번호"를 들고, 파일명은 +1 을 사용한다.
          this.currentIndex = maxIdx;
        } catch {
          // ignore — 디렉터리 없거나 접근 불가 시에는 기본값 유지
        } finally {
          this.fsIndexInitialized = true;
        }
      }

      // ── 2) 버퍼를 원자적으로 스냅샷하고 즉시 비워 동시성 창을 제거 ─────────────
      const buf = this.currentBuffer;
      const lines = buf.length;
      this.currentBuffer = [];
      this.writtenThisChunk = 0;
      if (lines === 0) {
        // 빈 flush 방지
        return { file: '', lines: 0 };
      }
      const text = buf.map((e) => JSON.stringify(e)).join('\n') + '\n';

      // ── 3) 다음 파트 파일명 산출 (+ 충돌 시 가용 번호까지 전진) ───────────────
      await fs.promises.mkdir(this.outDir, { recursive: true });
      // ⚠️ 경쟁 조건 방지: 임시 파일을 먼저 outDir에 고유 이름으로 만들고,
      //    최종 파일명으로의 rename을 "성공할 때까지" 인덱스를 올리며 재시도한다.
      //    (EEXIST/EPERM/EBUSY/ENOENT 등에 방어)
      const tmpBase = `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let tmpPath = path.join(this.outDir, tmpBase);
      await fs.promises.writeFile(tmpPath, text, 'utf8');

      let partName = '';
      let filePath = '';
      let renamed = false;
      // 무한 루프 방지를 위한 상한 (충분히 큼)
      const MAX_ATTEMPTS = 10_000;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !renamed; attempt++) {
        partName = `part-${String(this.currentIndex + 1).padStart(6, '0')}.ndjson`;
        filePath = path.join(this.outDir, partName);
        try {
          await fs.promises.rename(tmpPath, filePath);
          renamed = true;
        } catch (err: any) {
          const code = err?.code;
          if (code === 'EEXIST') {
            // 누가 먼저 차지했음 → 다음 번호로 시도
            this.currentIndex += 1;
            continue;
          }
          if (code === 'ENOENT') {
            // 디렉터리가 사라졌거나(경쟁) 소스가 없어짐 → 폴더 복구 후 임시파일 다시 생성
            await fs.promises.mkdir(this.outDir, { recursive: true });
            // 임시 파일이 사라졌다면 재작성
            try {
              await fs.promises.access(tmpPath, fs.constants.F_OK);
            } catch {
              tmpPath = path.join(this.outDir, `${tmpBase}-r`);
              await fs.promises.writeFile(tmpPath, text, 'utf8');
            }
            continue;
          }
          if (code === 'EPERM' || code === 'EBUSY') {
            // Windows에서 가끔 잠김 — 짧게 쉬고 다음 번호로 시도
            this.currentIndex += 1;
            await new Promise((r) => setTimeout(r, 10));
            continue;
          }
          // 기타 예외: 임시 파일 정리 후 전파
          try {
            await fs.promises.unlink(tmpPath);
          } catch {}
          throw err;
        }
      }
      if (!renamed) {
        // 안전망: 포기 시 임시 파일 정리
        try {
          await fs.promises.unlink(tmpPath);
        } catch {}
        throw new Error('ChunkWriter: failed to allocate a unique part file name');
      }

      this.currentIndex += 1;
      return { file: partName, lines };
    };

    // 직렬화 체인에 등록해 동시 호출을 순차 처리
    const p = this._serial.then(run, run);
    // 체인 유지(에러시에도 다음 작업 진행 가능하도록 에러 삼킴)
    this._serial = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }
}
