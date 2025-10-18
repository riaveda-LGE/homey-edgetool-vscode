// src/core/sessions/LogSessionManager.ts
import * as fs from 'fs';
import * as path from 'path';

import type { LogEntry } from '@ipc/messages';
import { DEFAULT_BATCH_SIZE, MERGED_CHUNK_MAX_LINES, MERGED_DIR_NAME, MERGED_MANIFEST_FILENAME } from '../../shared/const.js';
import { ErrorCategory,XError } from '../../shared/errors.js';
import { ConnectionManager, type HostConfig } from '../connection/ConnectionManager.js';
import { getLogger } from '../logging/extension-logger.js';
import { measure } from '../logging/perf.js';
import { ChunkWriter } from '../logs/ChunkWriter.js';
import { HybridLogBuffer } from '../logs/HybridLogBuffer.js';
import { countTotalLinesInDir, mergeDirectory, warmupTailPrepass } from '../logs/LogFileIntegration.js';
import { ManifestWriter } from '../logs/ManifestWriter.js';
import { paginationService } from '../logs/PaginationService.js';
import { Flags as FF, __setWarmupFlagsForTests } from '../../shared/featureFlags.js';

export type SessionCallbacks = {
  onBatch: (logs: LogEntry[], total?: number, seq?: number) => void;
  onMetrics?: (m: { buffer: any; mem: { rss: number; heapUsed: number } }) => void;
  /** 병합 결과 저장이 끝났을 때 호출(경로/메타 전달) */
  onSaved?: (info: { outDir: string; manifestPath: string; chunkCount: number; total?: number; merged: number }) => void;
  /** 병합 진행률(증분/상태) 전달 */
  onProgress?: (p: { inc?: number; total?: number; done?: number; active?: boolean }) => void;
  /** 정식 병합(T1) 완료 후 하드리프레시 지시 */
  onRefresh?: (p: { total?: number; version?: number }) => void;
};

export class LogSessionManager {
  private log = getLogger('LogSessionManager');
  private hb = new HybridLogBuffer();
  private seq = 0;
  private rtAbort?: AbortController;
  private cm?: ConnectionManager;

  // 진행률 스로틀 관련
  private lastProgressUpdate = 0;
  private lastProgressPercent = 0;
  private readonly PROGRESS_THROTTLE_MS = 250; // 250ms 간격
  private readonly PROGRESS_PERCENT_THRESHOLD = 1; // 1% 변화

  constructor(private conn?: HostConfig) {}

  // 진행률 스로틀 메서드
  private throttledOnProgress(opts: SessionCallbacks, current: {inc?: number, total?: number, done?: number, active?: boolean}) {
    const now = Date.now();
    const newPercent = current.total ? Math.round(((current.done || 0) / current.total) * 100) : 0;
    
    // 퍼센트 변화 ≥1% 또는 250ms 경과 또는 완료 시에만 업데이트
    if (Math.abs(newPercent - this.lastProgressPercent) >= this.PROGRESS_PERCENT_THRESHOLD || 
        now - this.lastProgressUpdate > this.PROGRESS_THROTTLE_MS || 
        !current.active) {
      this.lastProgressPercent = newPercent;
      this.lastProgressUpdate = now;
      opts.onProgress?.(current);
    }
  }

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
    this.log.info(`merge: flags warmupEnabled=${FF.warmupEnabled} warmupTarget=${FF.warmupTarget} perTypeCap=${FF.warmupPerTypeLimit} writeRaw=${FF.writeRaw}`);

    // 총 라인 수 추정 (실패 시 undefined)
    const total = await this.estimateTotalLinesSafe(opts.dir);
    this.log.info(`merge: estimated total lines=${total ?? 'unknown'}`);

    // 진행률: 시작 알림(0/total, active)
    opts.onProgress?.({ inc: 0, total, active: true });

    // ── T0: Manager 선행 웜업 ───────────────────────────────────────────────
    if (FF.warmupEnabled) {
      try {
        const warmLogs = await warmupTailPrepass({
          dir: opts.dir,
          signal: opts.signal,
          warmupPerTypeLimit: FF.warmupPerTypeLimit,
          warmupTarget: FF.warmupTarget,
        });
        if (warmLogs.length) {
          // idx(최신=1) 임시 부여 — 웜업 구간은 파일 쓰기 전이므로 로컬 인덱스 사용
          for (let i = 0; i < warmLogs.length; i++) (warmLogs[i] as any).idx = i + 1;
          // 메모리/웹뷰 준비
          paginationService.seedWarmupBuffer(warmLogs, warmLogs.length);
          this.hb.addBatch(warmLogs);
          const first = warmLogs.slice(0, Math.min(500, warmLogs.length));
          if (first.length) {
            this.log.info(`warmup(T0): deliver first ${first.length}/${warmLogs.length} (virtual total=${warmLogs.length})`);
            opts.onBatch(first, warmLogs.length, ++seq);
          }
          // Short-circuit: 웜업 수가 총합 이상이면 T1 스킵
          if (typeof total === 'number' && warmLogs.length >= total) {
            opts.onProgress?.({ done: total, total, active: false });
            this.log.info(`merge: short-circuit after warmup (warm=${warmLogs.length} >= total=${total}) — skip T1`);
            return;
          }
        } else {
          this.log.debug?.('warmup(T0): no lines collected — continue to T1');
        }
      } catch (e: any) {
        this.log.warn(`warmup(T0): failed (${e?.message ?? e}) — continue to T1`);
      }
    }

    // ── T1: 파일 병합 준비 (웜업으로 커버되지 않은 경우에만) ──────────────
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
    let paginationOpened = false;      // ✅ T0 시점에만 1회 open

    // (워밍업은 mergeDirectory의 warmup 옵션으로만 처리)

    // 중간 산출물 위치를 워크스페이스 산출물 폴더 하위로 고정
    //  - __jsonl : 타입별 정렬된 JSONL (k-way 병합 입력)
    //  - __raw   : (옵션) 보정 전 RAW JSONL
    const jsonlDir = path.join(outDir, '__jsonl');
    // 🔹 FF.writeRaw 가 true일 때만 RAW 스냅샷 경로 활성화
    const rawDir   = FF.writeRaw ? path.join(outDir, '__raw') : undefined;
    this.log.debug?.(
      `merge: intermediates jsonlDir=${jsonlDir} rawDir=${rawDir ?? '(disabled)'}`
    );

    await mergeDirectory({
      dir: opts.dir,
      reverse: false,
      signal: opts.signal,
      batchSize: DEFAULT_BATCH_SIZE,
      mergedDirPath: jsonlDir,
      // RAW 기록은 플래그가 true일 때만 활성화
      rawDirPath: FF.writeRaw ? rawDir : undefined,
      // Manager가 T0 웜업을 수행했으므로 여기서는 비활성화
      warmup: false,
      onBatch: async (logs: LogEntry[]) => {
        // 0) 전역 인덱스 부여
        for (const e of logs) {
          nextIdx += 1;
          (e as any).idx = nextIdx;
        }

        // 1) 메모리 버퍼 업데이트
        this.hb.addBatch(logs);

        // 2) 최초 500줄만 UI에 전달 (그 이후는 전달 금지)
        if (!sentInitial && !paginationService.isWarmupActive()) {
          initialBuffer.push(...logs);
          if (initialBuffer.length >= 500) {
            const slice = initialBuffer.slice(0, 500);
            const t = paginationService.isWarmupActive() ? paginationService.getWarmTotal() : total;
            this.log.info(`merge: initial deliver(len=${slice.length}) total=${t ?? 'unknown'} (warm=${paginationService.isWarmupActive()})`);
            // 워밍업이 이미 초기 500을 보냈다면 보통 여긴 실행되지 않지만,
            // 안전하게 가드 없이도 동일 total로 동작하도록 유지
            opts.onBatch(slice, t, ++seq);
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

        // 4-1) T0: 첫 청크 생성/manifest 저장 직후, Pagination을 즉시 오픈해 스크롤 요청 가능하게 함
        if (!paginationOpened && manifest.data.chunkCount > 0) {
          try {
            await paginationService.setManifestDir(outDir);
            this.log.info(`merge: pagination opened early (T0) dir=${outDir}`);
          } catch (e) {
            this.log.warn(`merge: early pagination open failed: ${String(e)}`);
          }
          paginationOpened = true;
        }

        // 5) 진행률 증분 알림 (스로틀 적용)
        this.throttledOnProgress(opts, { inc: logs.length, total, active: true });

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

    // ✅ T1: 최종 완료 시점에 최신 manifest로 리더 리로드
    if (!paginationOpened) {
      // (예외: 앞에서 열지 못한 경우 보정)
      await paginationService.setManifestDir(outDir);
    } else {
      await paginationService.reload();
    }
    this.log.info(`merge: pagination ready dir=${outDir} total=${manifest.data.totalLines ?? 'unknown'} merged=${manifest.data.mergedLines}`);
    // 파일 기반으로 스위치되면 워밍업 버퍼는 내부적으로 clear됨(reload에서 처리)
    if (!paginationService.isWarmupActive()) {
      this.log.info(`merge: switched to file-backed pagination (warm buffer cleared)`);
    }
    // 파일 기반 최신 500 재전송(정렬/보정 최종 결과로 UI 정합 맞춤)
    try {
      const freshHead = await paginationService.readRangeByIdx(1, 500);
      if (freshHead.length) {
        this.log.info(`merge: deliver refreshed head=${freshHead.length} (file-backed)`);
        opts.onBatch(freshHead, manifest.data.totalLines ?? total, ++seq);
      }
    } catch (e) {
      this.log.warn(`merge: failed to deliver refreshed head: ${String(e)}`);
    }

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

    // ✅ 웹뷰에 하드리프레시 지시(중복 제거/정렬 갱신 반영용)
    opts.onRefresh?.({ total: manifest.data.totalLines, version: paginationService.getVersion() });
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

// ⬇️ 테스트에서만 사용: 런타임 모드/리밋 주입 API (제품 코드에서 호출 금지)
export function __setLogMergeModeForTests(mode: 'warmup'|'kway', limit?: number) {
  const enabled = mode === 'warmup';
  __setWarmupFlagsForTests({ warmupEnabled: enabled, warmupPerTypeLimit: limit });
}
