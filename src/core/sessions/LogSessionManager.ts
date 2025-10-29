// src/core/sessions/LogSessionManager.ts
import type { LogEntry } from '@ipc/messages';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DEFAULT_BATCH_SIZE,
  LOG_WINDOW_SIZE,
  MERGED_CHUNK_MAX_LINES,
  MERGED_DIR_NAME,
  MERGED_MANIFEST_FILENAME,
} from '../../shared/const.js';
import { ErrorCategory, XError } from '../../shared/errors.js';
import type { ParserConfig } from '../config/schema.js';
import { connectionManager } from '../connection/ConnectionManager.js';
import { getLogger } from '../logging/extension-logger.js';
import { measure } from '../logging/perf.js';
import { ChunkWriter } from '../logs/ChunkWriter.js';
import { HybridLogBuffer } from '../logs/HybridLogBuffer.js';
import {
  compileWhitelistPathRegexes,
  countTotalLinesInDir,
  mergeDirectory,
  warmupTailPrepass,
} from '../logs/LogFileIntegration.js';
import { ManifestWriter } from '../logs/ManifestWriter.js';
import { paginationService } from '../logs/PaginationService.js';
import { compileParserConfig } from '../logs/ParserEngine.js';

export type SessionCallbacks = {
  onBatch: (logs: LogEntry[], total?: number, seq?: number) => void;
  onMetrics?: (m: { buffer: any; mem: { rss: number; heapUsed: number } }) => void;
  /** 병합 결과 저장이 끝났을 때 호출(경로/메타 전달) */
  onSaved?: (info: {
    outDir: string;
    manifestPath: string;
    chunkCount: number;
    total?: number;
    merged: number;
  }) => void;
  /** 병합 진행률(증분/상태) 전달 */
  onProgress?: (p: {
    inc?: number;
    total?: number;
    done?: number;
    active?: boolean;
    reset?: boolean;
  }) => void;
  /** 병합 단계 텍스트/상태 */
  onStage?: (text: string, kind?: 'start' | 'done' | 'info') => void;
  /** 정식 병합(T1) 완료 후 하드리프레시 지시 */
  onRefresh?: (p: { total?: number; version?: number; warm?: boolean }) => void;
};

export class LogSessionManager {
  private log = getLogger('LogSessionManager');
  private hb = new HybridLogBuffer();
  private seq = 0;
  private rtAbort?: AbortController;
  private rtFlushTimer?: NodeJS.Timeout;

  // 진행률 스로틀 관련
  private lastProgressUpdate = 0;
  private lastProgressPercent = 0;
  private readonly PROGRESS_THROTTLE_MS = 250; // 250ms 간격
  private readonly PROGRESS_PERCENT_THRESHOLD = 1; // 1% 변화

  constructor() {}

  // 진행률 스로틀 메서드
  private throttledOnProgress(
    opts: SessionCallbacks,
    current: { inc?: number; total?: number; done?: number; active?: boolean; reset?: boolean },
  ) {
    const now = Date.now();
    const newPercent = current.total
      ? Math.round((((current.done ?? 0) as number) / (current.total as number)) * 100)
      : 0;

    // 퍼센트 변화 ≥1% 또는 250ms 경과 또는 완료 시에만 업데이트
    if (
      Math.abs(newPercent - this.lastProgressPercent) >= this.PROGRESS_PERCENT_THRESHOLD ||
      now - this.lastProgressUpdate > this.PROGRESS_THROTTLE_MS ||
      !current.active
    ) {
      this.lastProgressPercent = newPercent;
      this.lastProgressUpdate = now;
      opts.onProgress?.(current);
    }
  }

  // -------------------- local helpers / env --------------------
  @measure()
  private readBooleanEnv(name: string, fallback: boolean): boolean {
    try {
      const v = (process as any)?.env?.[name];
      if (typeof v !== 'string') return fallback;
      const s = v.trim().toLowerCase();
      return s === '1' || s === 'true' || s === 'yes' || s === 'on';
    } catch {
      return fallback;
    }
  }

  @measure()
  async startRealtimeSession(
    opts: { signal?: AbortSignal; filter?: string; indexOutDir?: string } & SessionCallbacks,
  ) {
    this.log.info('realtime: start (file-backed + pagination)');
    // 활성 연결 확보(없으면 recent 로더로 자동 시도)
    await connectionManager.connect();
    if (!connectionManager.isConnected()) {
      throw new XError(
        ErrorCategory.Connection,
        '활성 연결이 없습니다. 먼저 "기기 연결"을 수행하세요.',
      );
    }
    const snap = connectionManager.getSnapshot();
    const active = snap.active;
    const sourceType = active?.type ?? 'unknown';

    this.rtAbort = new AbortController();
    if (opts.signal) opts.signal.addEventListener('abort', () => this.rtAbort?.abort());

    // ── 출력 디렉터리(실시간) 준비 ────────────────────────────────────────
    // - caller가 indexOutDir을 준 경우 우선
    // - 그 외에는 OS temp 하위에 <MERGED_DIR_NAME>-rt-<pid> 고정 사용
    const baseOut =
      opts.indexOutDir || path.join(os.tmpdir(), `${MERGED_DIR_NAME}-rt-${process.pid}`);
    const outDir = await this.prepareCleanOutputDir(baseOut);
    this.log.info(`realtime: outDir=${outDir}`);

    // manifest / chunk writer
    const manifest = await ManifestWriter.loadOrCreate(outDir);
    const chunkWriter = new ChunkWriter(outDir, MERGED_CHUNK_MAX_LINES, manifest.data.chunkCount);
    let mergedSoFar = manifest.data.mergedLines ?? 0;
    let paginationOpened = false;

    // flush 코얼레서
    const PULSE_MS = 250;
    let pending: LogEntry[] = [];
    const doFlush = async (reason: string) => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];

      // 1) 메모리 메트릭
      this.hb.addBatch(batch);

      // 2) 디스크 청크 append + manifest 스냅샷
      const parts = await chunkWriter.appendBatch(batch);
      for (const p of parts) {
        manifest.addChunk(p.file, p.lines, mergedSoFar);
        mergedSoFar += p.lines;
      }
      manifest.setTotal(mergedSoFar);
      await manifest.save();

      // 3) 페이지네이션 오픈/리로드
      try {
        if (!paginationOpened) {
          await paginationService.setManifestDir(outDir);
          paginationOpened = true;
          // ✅ 파일기반 세션 버전을 웹뷰에 전달(웹뷰가 페이지 요청을 바로 시작하도록)
          try {
            opts.onRefresh?.({
              total: mergedSoFar,
              version: paginationService.getVersion(),
            });
          } catch {}
        } else if (parts.length) {
          // 새 청크가 만들어진 경우에만 리로드(비용 절감)
          await paginationService.reload();
        }
      } catch (e) {
        this.log.warn(`realtime: pagination prepare failed: ${String(e)}`);
      }

      // 4) 최신 윈도우 구간을 읽어 교체 푸시
      try {
        const total = mergedSoFar;
        const endIdx = Math.max(1, total);
        const startIdx = Math.max(1, endIdx - LOG_WINDOW_SIZE + 1);
        const page = await paginationService.readRangeByIdx(startIdx, endIdx);
        if (page.length) {
          opts.onBatch(page, total, ++this.seq);
        }
      } catch (e) {
        this.log.warn(`realtime: failed to deliver last page: ${String(e)}`);
      }

      // 5) 메트릭
      opts.onMetrics?.({
        buffer: this.hb.getMetrics(),
        mem: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed },
      });
      this.log.debug?.(`realtime.flush[${reason}] batch=${batch.length} total=${mergedSoFar}`);
    };

    const schedulePulse = () => {
      if (this.rtFlushTimer) return;
      this.rtFlushTimer = setTimeout(async () => {
        this.rtFlushTimer = undefined;
        try {
          await doFlush('pulse');
        } finally {
          // 지속적으로 입력이 올 수 있으므로 다음 펄스는 필요 시 다시 예약
          if (pending.length) schedulePulse();
        }
      }, PULSE_MS);
    };

    const cmd =
      active?.type === 'ADB'
        ? `logcat -v time`
        : `sh -lc 'journalctl -f -o short-iso -n 0 -u "homey*" 2>/dev/null || docker ps --format "{{.Names}}" | awk "/homey/{print}" | xargs -r -n1 docker logs -f --since 0s'`;

    this.log.debug?.(`realtime: streaming cmd="${cmd}"`);
    await connectionManager.stream(
      cmd,
      (line: string) => {
        // 실시간은 "전체 라인"을 파일에 보존(필터는 PaginationService 경로에서 처리)
        const e: LogEntry = {
          id: Date.now(),
          ts: Date.now(),
          level: 'I',
          type: 'system',
          source: sourceType,
          text: line,
        };
        pending.push(e);
        // 첫 라인이 들어오면 즉시 펄스 예약(뭉텅이로 처리)
        schedulePulse();
      },
      this.rtAbort.signal,
    );

    // 스트림 종료 시 잔여 플러시
    try {
      await doFlush('final');
      const rem = await chunkWriter.flushRemainder();
      if (rem) {
        manifest.addChunk(rem.file, rem.lines, mergedSoFar);
        mergedSoFar += rem.lines;
        manifest.setTotal(mergedSoFar);
        await manifest.save();
        await paginationService.reload();
      }
      // 마지막 페이지 재전송(세션 종료 전 정합)
      const total = mergedSoFar;
      const endIdx = Math.max(1, total);
      const startIdx = Math.max(1, endIdx - LOG_WINDOW_SIZE + 1);
      const tail = await paginationService.readRangeByIdx(startIdx, endIdx);
      if (tail.length) opts.onBatch(tail, total, ++this.seq);
    } catch (e) {
      this.log.warn(`realtime: final flush failed: ${String(e)}`);
    } finally {
      // stream 종료 처리 이후에
      if (this.rtFlushTimer) {
        clearTimeout(this.rtFlushTimer);
        this.rtFlushTimer = undefined;
      }
    }
  }

  /**
   * 파일 병합 세션
   * - 병합 전 총 라인수를 추정해 onBatch(..., total)로 전달
   * - 결과를 outDir/<part-*.ndjson> + manifest.json 으로 저장
   * - 실시간 뷰로는 "최초 최신 LOG_WINDOW_SIZE만큼" 전송하고, 이후는 스크롤 요청에만 응답
   */
  @measure()
  async startFileMergeSession(
    opts: {
      dir: string;
      signal?: AbortSignal;
      indexOutDir?: string;
      whitelistGlobs?: string[];
      parserConfig?: ParserConfig;
    } & SessionCallbacks,
  ) {
    this.log.info(`[debug] LogSessionManager.startFileMergeSession: start dir=${opts.dir}`);
    let seq = 0;
    // 진행 누적(세션 로컬)
    let progressDone = 0;
    // 단계 텍스트
    opts.onStage?.('병합 세션 시작', 'info');

    // 파서 설정에서 conservative 메모리 모드 문턱 추출
    const configuredThreshold = Number(
      (opts.parserConfig as any)?.configure?.memory_mode_threshold,
    );
    const DEFAULT_THRESHOLD = 10_000;
    const threshold =
      Number.isFinite(configuredThreshold) && configuredThreshold > 0
        ? configuredThreshold
        : DEFAULT_THRESHOLD;

    // 테스트 오버라이드(있으면)
    const warmupEnabled =
      _testWarmupEnabledOverride === undefined ? true : _testWarmupEnabledOverride;
    const perTypeLimit = Number.isFinite(_testWarmupPerTypeLimitOverride ?? NaN)
      ? (_testWarmupPerTypeLimitOverride as number)
      : Number.POSITIVE_INFINITY;

    // 총 라인 수 추정 (화이트리스트 반영; 실패 시 undefined)
    const total = await this.estimateTotalLinesSafe(opts.dir, opts.whitelistGlobs);
    this.log.info(`T*: estimated total lines=${total ?? 'unknown'}`);

    // 진행률: 시작 알림(0/total, active)
    progressDone = 0;
    opts.onProgress?.({ done: 0, total, active: true, reset: true });

    // ── T0: Manager 선행 웜업 ───────────────────────────────────────────────
    if (warmupEnabled) {
      try {
        const warm = await warmupTailPrepass({
          dir: opts.dir,
          signal: opts.signal,
          // 보수적 기준의 정확도를 높이기 위해 per-type cap 제거(무한)
          warmupPerTypeLimit: perTypeLimit,
          // 메모리 모드 문턱만큼만 웜업하여 UI 최초 화면 품질을 맞춤
          memory_mode_threshold: threshold,
          whitelistGlobs: opts.whitelistGlobs,
          parser: opts.parserConfig, // ✅ T0에도 parser 적용
        });
        const warmLogs = warm.logs;
        if (warmLogs.length) {
          // 메모리/웹뷰 준비
          paginationService.seedWarmupBuffer(warmLogs, warmLogs.length);
          this.hb.addBatch(warmLogs);
          // ✅ 초기 전달: "마지막 페이지(최신 영역)"을 오름차순으로 보냄
          const totalWarm = warmLogs.length;
          const endIdx = totalWarm;
          const startIdx = Math.max(1, endIdx - LOG_WINDOW_SIZE + 1);
          const lastPage = await paginationService.readRangeByIdx(startIdx, endIdx);
          if (lastPage.length) {
            this.log.info(
              `warmup(T0): deliver last-page ${startIdx}-${endIdx} (${lastPage.length}/${totalWarm})`,
            );
            opts.onBatch(lastPage, totalWarm, ++seq);
          }
          // ⬇️ 진행률 보강: T0만으로도 사용자에게 "진행 중"임을 보여주기 위해
          //    웜업으로 확보한 라인 수를 done으로 고정 전송한다.
          //    (T1로 이어지면 이후 onBatch에서 증가분이, warm-skip이면 onFinalize에서
          //     active:false가 내려와 진행바가 닫힌다)
          const warmDone = Math.max(0, totalWarm);
          if (warmDone > 0) {
            const nextDone = warmDone;
            const inc = nextDone - progressDone;
            progressDone = nextDone;
            this.throttledOnProgress(opts, {
              inc,
              done: nextDone,
              total,
              active: true,
            });
          }
          // ⚠️ 스킵 결정의 단일 권위(SSOT)는 mergeDirectory에 있음.
          // T0에서 스킵을 '제안'할 수는 있지만 여기서 조기 종료하지 않는다.
          if (warm.fullyCovered && totalWarm <= threshold) {
            this.log.info(
              `T*: warm suggests skip (warm=${totalWarm} ≤ threshold=${threshold}, fullyCovered) — deferring decision to mergeDirectory`,
            );
          }
        } else {
          this.log.debug?.('warmup(T0): skipped or not enough lines');
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
    this.log.info(`T1: outDir=${outDir}`);
    // (이전 featureFlags.writeRaw 대체) — 환경변수로 RAW 기록 on/off
    const writeRaw = this.readBooleanEnv('HOMEY_WRITE_RAW', false);

    // 파서 컴파일
    const compiledParser = opts.parserConfig ? compileParserConfig(opts.parserConfig) : undefined;

    // manifest / chunk writer 준비
    const manifest = await ManifestWriter.loadOrCreate(outDir);
    // ⬇️ 빈 데이터셋이어도 manifest.json이 존재하도록 선 저장
    //    - 이후 paginationService.setManifestDir(outDir)에서 ENOENT 방지
    manifest.setTotal(typeof total === 'number' ? total : 0);
    await manifest.save();
    const chunkWriter = new ChunkWriter(outDir, MERGED_CHUNK_MAX_LINES, manifest.data.chunkCount);
    this.log.debug?.(
      `T1: manifest loaded chunks=${manifest.data.chunkCount} mergedLines=${manifest.data.mergedLines ?? 0}`,
    );

    // (주의) 전역 인덱스는 페이지 서비스에서 오름차순으로 부여한다.
    let mergedSoFar = manifest.data.mergedLines ?? 0;
    let sentInitial = false; // ✅ 최초 LOG_WINDOW_SIZE만 보낼 가드
    const initialBuffer: LogEntry[] = [];
    let paginationOpened = false; // ✅ T0 시점에만 1회 open

    // (워밍업은 mergeDirectory의 warmup 옵션으로만 처리)

    // 중간 산출물 위치를 워크스페이스 산출물 폴더 하위로 고정
    //  - __jsonl : 타입별 정렬된 JSONL (k-way 병합 입력)
    //  - __raw   : (옵션) 보정 전 RAW JSONL
    const jsonlDir = path.join(outDir, '__jsonl');
    // 🔹 환경변수(HOMEY_WRITE_RAW)가 true일 때만 RAW 스냅샷 경로 활성화
    const rawDir = writeRaw ? path.join(outDir, '__raw') : undefined;
    this.log.debug?.(`T1: intermediates jsonlDir=${jsonlDir} rawDir=${rawDir ?? '(disabled)'}`);

    let skippedToMemory = false;

    await mergeDirectory({
      dir: opts.dir,
      reverse: false,
      signal: opts.signal,
      batchSize: DEFAULT_BATCH_SIZE,
      mergedDirPath: jsonlDir,
      // RAW 기록은 플래그가 true일 때만 활성화
      rawDirPath: writeRaw ? rawDir : undefined,
      // Manager가 T0 웜업을 수행했으므로 여기서는 비활성화
      warmup: false,
      whitelistGlobs: opts.whitelistGlobs,
      parser: opts.parserConfig,
      preserveFullText: true,
      // ⬇️ 타입별 정렬/병합 시작 등의 단계 신호를 그대로 위로 올려서 UI까지 전달
      onStage: (text, kind) => opts.onStage?.(text, kind),
      // ⬇️ 진행률 이벤트 패스스루(사전 총량 추정/스킵 완료 신호 포함)
      //    - mergeDirectory 내부 pre-estimate/skip 경로에서 내려오는 onProgress를
      //      그대로 UI까지 끌어올린다.
      onProgress: (r) => {
        // total은 mergeDirectory가 알려주면 사용하고, 없으면 최초 estimate(total)를 유지
        const nextDone = typeof r?.done === 'number' && r.done >= 0 ? r.done : progressDone;
        const inc = typeof nextDone === 'number' ? nextDone - progressDone : undefined;
        progressDone = typeof nextDone === 'number' ? nextDone : progressDone;
        this.throttledOnProgress(opts, {
          inc,
          done: nextDone,
          total: typeof r?.total === 'number' ? r.total : total,
          active: r?.active,
        });
      },
      // 스킵 경로에서도 warm 버퍼가 보장되도록(테스트/설정에 따라 T0가 비활성일 수 있음)
      onWarmupBatch: (logs) => {
        try {
          if (!paginationService.isWarmupActive() && logs?.length) {
            paginationService.seedWarmupBuffer(logs, logs.length);
          }
        } catch {}
      },
      // mergeDirectory가 최종 결론을 내리면 여기로 들어온다.
      onFinalize: (r) => {
        if (r.mode === 'memory') {
          skippedToMemory = true;
          const totalMem = r.total ?? paginationService.getWarmTotal();
          opts.onProgress?.({ done: totalMem, total: totalMem, active: false });
          opts.onRefresh?.({
            total: totalMem,
            version: paginationService.getVersion(),
            warm: true,
          });
        }
      },
      onBatch: async (logs: LogEntry[]) => {
        // 1) 메모리 버퍼 업데이트
        this.hb.addBatch(logs);

        // 2) 최초 LOG_WINDOW_SIZE줄만 UI에 전달 (그 이후는 전달 금지)
        if (!sentInitial && !paginationService.isWarmupActive()) {
          initialBuffer.push(...logs);
          if (initialBuffer.length >= LOG_WINDOW_SIZE) {
            // 최신부터 쌓인 버퍼이므로, 오름차순 표시를 위해 뒤집어서 보냄
            const slice = initialBuffer.slice(0, LOG_WINDOW_SIZE).slice().reverse();
            const t = paginationService.isWarmupActive() ? paginationService.getWarmTotal() : total;
            this.log.info(
              `T1: initial deliver(len=${slice.length}) total=${t ?? 'unknown'} (warm=${paginationService.isWarmupActive()}, window=${LOG_WINDOW_SIZE})`,
            );
            // 워밍업이 이미 초기 500을 보냈다면 보통 여긴 실행되지 않지만,
            // 안전하게 가드 없이도 동일 total로 동작하도록 유지
            opts.onBatch(slice, t, ++seq);
            sentInitial = true;
          }
        }

        // 3) 청크 파일 쓰기
        const createdParts = await chunkWriter.appendBatch(logs);
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
          } catch (e) {
            this.log.warn(`T1: early pagination open failed: ${String(e)}`);
          }
          paginationOpened = true;
        }

        // NOTE: 일부 환경에서 manifest 스냅샷 직후 곧바로 큰 범위를 읽으면
        //       I/O 캐시 타이밍에 따라 간헐적으로 빈 슬라이스가 나올 수 있다.
        //       여기서는 오로지 초기 오픈만 수행하고, 실제 tail 페이징은
        //       웹뷰 요청에 의해 이뤄지도록(=빈 화면 순간을 최소화) 위임한다.

        // 5) 진행률 증분 알림 (스로틀 적용)
        progressDone += logs.length;
        this.throttledOnProgress(opts, {
          inc: logs.length,
          done: progressDone,
          total,
          active: true,
        });

        // 6) 메트릭
        opts.onMetrics?.({
          buffer: this.hb.getMetrics(),
          mem: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed },
        });
      },
    });
    // mergeDirectory에서 메모리 모드 스킵으로 종료된 경우, 파일 기반 후처리를 건너뛴다.
    if (skippedToMemory) {
      this.log.info(
        'T1: finalized via memory-mode skip (mergeDirectory). Exiting file-merge path.',
      );
      return;
    }

    // 남은 버퍼 플러시
    const remainder = await chunkWriter.flushRemainder();
    if (remainder) {
      manifest.addChunk(remainder.file, remainder.lines, mergedSoFar);
      mergedSoFar += remainder.lines;
      this.log.debug?.(`T1: remainder flushed lines=${remainder.lines}`);
      await manifest.save();
      // ❌ 중복 누적 방지를 위해 여기서는 진행률 inc 전송하지 않음
      // (최종 done/total 신호로 바를 고정)
    }

    // ✅ T1: 최종 완료 시점에 최신 manifest로 리더 리로드
    try {
      // (앞서 part 생성이 없어 아직 열지 못했다면 여기서 1회 오픈)
      if (!paginationOpened) {
        await paginationService.setManifestDir(outDir);
        paginationOpened = true;
        // ※ 일부 환경에서 setManifestDir만 호출되고 reload가 누락되면
        //    서비스가 계속 'warm' 모드에 머물러 페이징이 꼬일 수 있다.
        //    (로그에서 관찰된 현상: out-of-range 요청이 항상 워밍업 꼬리로 clamp)
        //    따라서 최종 완료 시점에는 무조건 reload를 수행해 파일 기반으로 전환한다.
        await paginationService.reload();
      } else {
        await paginationService.reload();
      }
    } catch (e) {
      this.log.warn(`T1: pagination finalize failed (possibly empty dataset): ${String(e)}`);
    }
    this.log.info(
      `T1: pagination ready dir=${outDir} total=${manifest.data.totalLines ?? 'unknown'} merged=${manifest.data.mergedLines}`,
    );
    // 파일 기반으로 스위치되면 워밍업 버퍼는 내부적으로 clear됨(reload에서 처리)
    if (!paginationService.isWarmupActive()) {
      this.log.info(`T1: switched to file-backed pagination (warm buffer cleared)`);
    }
    // 파일 기반 최신 head 재전송(정렬/보정 최종 결과로 UI 정합 맞춤)
    try {
      // ⚠️ tail 계산은 반드시 "실제 저장된 라인 수"를 우선 사용
      const totalLines = manifest.data.mergedLines ?? manifest.data.totalLines ?? total ?? 0;
      const endIdx = Math.max(1, totalLines);
      const startIdx = Math.max(1, endIdx - LOG_WINDOW_SIZE + 1);
      const freshTail = await paginationService.readRangeByIdx(startIdx, endIdx);
      if (freshTail.length) {
        this.log.info(
          `T1: deliver refreshed last-page ${startIdx}-${endIdx} (${freshTail.length}) (file-backed, window=${LOG_WINDOW_SIZE})`,
        );
        opts.onBatch(freshTail, totalLines, ++seq);
      }
    } catch (e) {
      this.log.warn(`T1: failed to deliver refreshed head: ${String(e)}`);
    }

    // 완료 알림(바 고정 목적)
    opts.onProgress?.({
      done: manifest.data.mergedLines,
      total: manifest.data.totalLines ?? total,
      active: false,
    });

    opts.onStage?.('파일 병합 완료', 'done');

    opts.onSaved?.({
      outDir,
      manifestPath: path.join(outDir, MERGED_MANIFEST_FILENAME),
      chunkCount: manifest.data.chunkCount,
      total: manifest.data.totalLines,
      merged: manifest.data.mergedLines,
    });

    // ✅ 웹뷰에 하드리프레시 지시(중복 제거/정렬 갱신 반영용)
    opts.onRefresh?.({
      // total은 mergedLines로 고정 (UI 스크롤/점프 총량 일치)
      total: manifest.data.mergedLines ?? manifest.data.totalLines,
      version: paginationService.getVersion(),
    });
    this.log.info(`[debug] LogSessionManager.startFileMergeSession: end`);
  }

  @measure()
  stopAll() {
    this.log.info('session: stopAll');
    // ✅ 실시간 플러시 타이머 정리(종료 후 지연 flush 방지)
    if (this.rtFlushTimer) {
      clearTimeout(this.rtFlushTimer);
      this.rtFlushTimer = undefined;
    }
    this.rtAbort?.abort();
  }

  @measure()
  dispose() {
    this.stopAll();
    this.hb?.clear();
  }

  // -------------------- helpers --------------------

  /** 총 라인 수 추정 (에러 시 undefined) */
  @measure()
  private async estimateTotalLinesSafe(
    dir: string,
    whitelistGlobs?: string[],
  ): Promise<number | undefined> {
    try {
      return await this.estimateTotalLines(dir, whitelistGlobs);
    } catch (e) {
      this.log.warn(`estimateTotalLines failed: ${String(e)}`);
      return undefined;
    }
  }

  /** 실제 병합과 동일한 규칙(EOF 개행 없음 보정 포함)으로 총 라인수를 계산 */
  @measure()
  private async estimateTotalLines(dir: string, whitelistGlobs?: string[]): Promise<number> {
    const allow = whitelistGlobs?.length ? compileWhitelistPathRegexes(whitelistGlobs) : undefined;
    const { total } = await countTotalLinesInDir(dir, allow);
    return total;
  }

  /** outDir이 이미 존재하며 manifest가 있으면 새 폴더로 회피하여 덮어쓰기 안전 보장 */
  @measure()
  private async prepareCleanOutputDir(baseOutDir: string): Promise<string> {
    try {
      await fs.promises.mkdir(baseOutDir, { recursive: true });
      const mf = path.join(baseOutDir, MERGED_MANIFEST_FILENAME);
      try {
        await fs.promises.stat(mf);
        const ts = new Date()
          .toISOString()
          .replace(/[-:TZ.]/g, '')
          .slice(0, 14);
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

// -------------------- tests only overrides (featureFlags 제거 대체) --------------------
let _testWarmupEnabledOverride: boolean | undefined = undefined;
let _testWarmupPerTypeLimitOverride: number | undefined = undefined;
let _testWarmupTargetOverride: number | undefined = undefined;

/** 테스트에서만 사용: 런타임 모드/리밋 주입 API (제품 코드에서 호출 금지) */
export function __setLogMergeModeForTests(mode: 'warmup' | 'kway', limit?: number) {
  _testWarmupEnabledOverride = mode === 'warmup';
  _testWarmupPerTypeLimitOverride = typeof limit === 'number' ? limit : undefined;
}

/** 테스트에서만 사용: 메모리 모드 threshold 주입 */
export function __setMemoryModeThresholdForTests(threshold?: number) {
  _testWarmupTargetOverride = typeof threshold === 'number' ? threshold : undefined;
}
