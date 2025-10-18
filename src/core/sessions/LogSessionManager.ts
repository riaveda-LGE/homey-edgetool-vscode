// src/core/sessions/LogSessionManager.ts
import * as fs from 'fs';
import * as path from 'path';

import type { LogEntry } from '../../extension/messaging/messageTypes.js';
import { DEFAULT_BATCH_SIZE, MERGED_CHUNK_MAX_LINES, MERGED_DIR_NAME, MERGED_MANIFEST_FILENAME } from '../../shared/const.js';
import { ErrorCategory,XError } from '../../shared/errors.js';
import { ConnectionManager, type HostConfig } from '../connection/ConnectionManager.js';
import { getLogger } from '../logging/extension-logger.js';
import { measure } from '../logging/perf.js';
import { ChunkWriter } from '../logs/ChunkWriter.js';
import { HybridLogBuffer } from '../logs/HybridLogBuffer.js';
import { countTotalLinesInDir,mergeDirectory } from '../logs/LogFileIntegration.js';
import { ManifestWriter } from '../logs/ManifestWriter.js';
import { paginationService } from '../logs/PaginationService.js';

export type SessionCallbacks = {
  onBatch: (logs: LogEntry[], total?: number, seq?: number) => void;
  onMetrics?: (m: { buffer: any; mem: { rss: number; heapUsed: number } }) => void;
  /** 병합 결과 저장이 끝났을 때 호출(경로/메타 전달) */
  onSaved?: (info: { outDir: string; manifestPath: string; chunkCount: number; total?: number; merged: number }) => void;
  /** 병합 진행률(증분/상태) 전달 */
  onProgress?: (p: { inc?: number; total?: number; done?: number; active?: boolean }) => void;
};

export class LogSessionManager {
  private log = getLogger('LogSessionManager');
  private hb = new HybridLogBuffer();
  private seq = 0;
  private rtAbort?: AbortController;
  private cm?: ConnectionManager;

  constructor(private conn?: HostConfig) {}

  @measure()
  async startRealtimeSession(opts: { signal?: AbortSignal; filter?: string } & SessionCallbacks) {
    this.log.info('realtime: start');
    if (!this.conn) throw new XError(ErrorCategory.Connection, 'No connection configured');

    this.cm = new ConnectionManager(this.conn);
    await this.cm.connect();

    this.rtAbort = new AbortController();
    if (opts.signal) opts.signal.addEventListener('abort', () => this.rtAbort?.abort());

    const filter = (s: string) => {
      const f = opts.filter?.trim();
      return !f || s.toLowerCase().includes(f.toLowerCase());
    };

    const cmd =
      this.conn.type === 'adb'
        ? `logcat -v time`
        : `sh -lc 'journalctl -f -o short-iso -n 0 -u "homey*" 2>/dev/null || docker ps --format "{{.Names}}" | awk "/homey/{print}" | xargs -r -n1 docker logs -f --since 0s'`;

    this.log.debug?.(`realtime: streaming cmd="${cmd}"`);
    await this.cm.stream(
      cmd,
      (line) => {
        if (!filter(line)) return;
        const e: LogEntry = {
          id: Date.now(),
          ts: Date.now(),
          level: 'I',
          type: 'system',
          source: this.conn!.type,
          text: line,
        };
        this.hb.add(e);
        opts.onBatch([e], undefined, ++this.seq);
        opts.onMetrics?.({
          buffer: this.hb.getMetrics(),
          mem: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed },
        });
      },
      this.rtAbort.signal,
    );
  }

  /**
   * 파일 병합 세션
   * - 병합 전 총 라인수를 추정해 onBatch(..., total)로 전달
   * - 결과를 outDir/<part-*.ndjson> + manifest.json 으로 저장
   * - 실시간 뷰로는 "최초 최신 500줄"만 전송하고, 이후는 스크롤 요청에만 응답
   */
  @measure()
  async startFileMergeSession(
    opts: { dir: string; signal?: AbortSignal; indexOutDir?: string } & SessionCallbacks,
  ) {
    this.log.info(`merge: session start dir=${opts.dir}`);
    let seq = 0;

    // 총 라인 수 추정 (실패 시 undefined)
    const total = await this.estimateTotalLinesSafe(opts.dir);
    this.log.info(`merge: estimated total lines=${total ?? 'unknown'}`);

    // 진행률: 시작 알림(0/total, active)
    opts.onProgress?.({ inc: 0, total, active: true });

    // 출력 디렉터리 결정
    //   - PanelManager가 넘겨준 indexOutDir(= <workspace>/raw/merge_log)을 최우선 사용
    //   - 없으면 기존 규칙(<선택폴더>/merge_log) 사용
    const baseOut = opts.indexOutDir || path.join(opts.dir, MERGED_DIR_NAME);
    const outDir = await this.prepareCleanOutputDir(baseOut);
    this.log.info(`merge: outDir=${outDir}`);

    // manifest / chunk writer 준비
    const manifest = await ManifestWriter.loadOrCreate(outDir);
    manifest.setTotal(total);
    const chunkWriter = new ChunkWriter(outDir, MERGED_CHUNK_MAX_LINES, manifest.data.chunkCount);
    this.log.debug?.(
      `merge: manifest loaded chunks=${manifest.data.chunkCount} mergedLines=${manifest.data.mergedLines ?? 0}`
    );

    // 전역 인덱스 부여(최신=1). 과거에 이어쓸 수 있으므로 기저값은 mergedLines.
    let nextIdx = (manifest.data.mergedLines ?? 0);
    let mergedSoFar = manifest.data.mergedLines;
    let sentInitial = false;           // ✅ 최초 500줄만 보낼 가드
    const initialBuffer: LogEntry[] = [];

    // 중간 산출물 위치를 워크스페이스 산출물 폴더 하위로 고정
    //  - __jsonl : 타입별 정렬된 JSONL (k-way 병합 입력)
    //  - __raw   : (옵션) 보정 전 RAW JSONL
    const jsonlDir = path.join(outDir, '__jsonl');
    const rawDir   = path.join(outDir, '__raw');
    this.log.debug?.(`merge: intermediates jsonlDir=${jsonlDir} rawDir=${rawDir}`);

    await mergeDirectory({
      dir: opts.dir,
      reverse: false,
      signal: opts.signal,
      batchSize: DEFAULT_BATCH_SIZE,
      mergedDirPath: jsonlDir,
      rawDirPath: rawDir,
      onBatch: async (logs) => {
        // 0) 전역 인덱스 부여
        for (const e of logs) {
          nextIdx += 1;
          (e as any).idx = nextIdx;
        }

        // 1) 메모리 버퍼 업데이트
        this.hb.addBatch(logs);

        // 2) 최초 500줄만 UI에 전달 (그 이후는 전달 금지)
        if (!sentInitial) {
          initialBuffer.push(...logs);
          if (initialBuffer.length >= 500) {
            const slice = initialBuffer.slice(0, 500);
            this.log.info(`merge: initial deliver len=${slice.length} total=${total ?? 'unknown'}`);
            opts.onBatch(slice, total, ++seq);
            sentInitial = true;
          }
        }

        // 3) 청크 파일 쓰기
        const createdParts = await chunkWriter.appendBatch(logs);
        if (createdParts.length) {
          this.log.debug?.(`merge: chunk append parts=${createdParts.length}`);
        }
        for (const p of createdParts) {
          manifest.addChunk(p.file, p.lines, mergedSoFar);
          mergedSoFar += p.lines;
        }
        // 4) manifest 스냅샷
        await manifest.save();

        // 5) 진행률 증분 알림
        opts.onProgress?.({ inc: logs.length, total, active: true });

        // 6) 메트릭
        opts.onMetrics?.({
          buffer: this.hb.getMetrics(),
          mem: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed },
        });
      },
    });

    // 남은 버퍼 플러시
    const remainder = await chunkWriter.flushRemainder();
    if (remainder) {
      manifest.addChunk(remainder.file, remainder.lines, mergedSoFar);
      mergedSoFar += remainder.lines;
      this.log.debug?.(`merge: remainder flushed lines=${remainder.lines}`);
      await manifest.save();
      // ❌ 중복 누적 방지를 위해 여기서는 진행률 inc 전송하지 않음
      // (최종 done/total 신호로 바를 고정)
    }

    // ✅ 페이지네이션 서비스에 현재 결과 등록(스크롤 요청 대비)
    await paginationService.setManifestDir(outDir);
    this.log.info(
      `merge: pagination ready dir=${outDir} total=${manifest.data.totalLines ?? 'unknown'} merged=${manifest.data.mergedLines}`
    );

    // 완료 알림(바 고정 목적)
    opts.onProgress?.({
      done: manifest.data.mergedLines,
      total: manifest.data.totalLines ?? total,
      active: false,
    });

    opts.onSaved?.({
      outDir,
      manifestPath: path.join(outDir, MERGED_MANIFEST_FILENAME),
      chunkCount: manifest.data.chunkCount,
      total: manifest.data.totalLines,
      merged: manifest.data.mergedLines,
    });
  }

  @measure()
  stopAll() {
    this.log.info('session: stopAll');
    this.rtAbort?.abort();
    this.cm?.dispose();
  }

  dispose() {
    this.stopAll();
    this.cm?.dispose();
    this.hb?.clear();
  }

  // -------------------- helpers --------------------

  /** 총 라인 수 추정 (에러 시 undefined) */
  private async estimateTotalLinesSafe(dir: string): Promise<number | undefined> {
    try {
      return await this.estimateTotalLines(dir);
    } catch (e) {
      this.log.warn(`estimateTotalLines failed: ${String(e)}`);
      return undefined;
    }
  }

  /** 실제 병합과 동일한 규칙(EOF 개행 없음 보정 포함)으로 총 라인수를 계산 */
  private async estimateTotalLines(dir: string): Promise<number> {
    const { total } = await countTotalLinesInDir(dir);
    return total;
  }

  /** outDir이 이미 존재하며 manifest가 있으면 새 폴더로 회피하여 덮어쓰기 안전 보장 */
  private async prepareCleanOutputDir(baseOutDir: string): Promise<string> {
    try {
      await fs.promises.mkdir(baseOutDir, { recursive: true });
      const mf = path.join(baseOutDir, MERGED_MANIFEST_FILENAME);
      try {
        await fs.promises.stat(mf);
        const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
        const next = `${baseOutDir}-${ts}`;
        await fs.promises.mkdir(next, { recursive: true });
        return next;
      } catch {
        return baseOutDir;
      }
    } catch (e) {
      this.log.warn(`prepareCleanOutputDir failed: ${String(e)}`);
      return baseOutDir;
    }
  }
}
