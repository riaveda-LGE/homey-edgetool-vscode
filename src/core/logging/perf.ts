// === src/core/logging/perf.ts ===
import * as fs from 'fs';

// (removed unused import 'path')

import { LOG_TOTAL_CALLS_THRESHOLD } from '../../shared/const.js';

export function perfNow() {
  const [s, ns] = process.hrtime();
  return s * 1e3 + ns / 1e6;
}

// vscode 타입은 지연 로드(테스트/웹뷰 환경 보호)
type VSCodeModule = typeof import('vscode');
function pathToString(p: any): string {
  try {
    if (!p) return String(p);
    if (typeof p === 'string') return p;
    if (p?.fsPath) return String(p.fsPath);
    if (p?.path) return String(p.path);
    if (p instanceof URL) return p.toString();
    return String(p);
  } catch { return String(p); }
}

export interface IOPerformanceMetrics {
  operation: string;
  path: string;
  startTime: number;
  endTime: number;
  duration: number;
  bytesTransferred?: number;
  error?: string;
}

// (레거시) 단발 I/O 측정 헬퍼(내부에서만 사용 가능하게 유지). 외부 노출/사용 지양.
export async function measureFileRead(filePath: string): Promise<IOPerformanceMetrics> {
  const startTime = perfNow();

  try {
    const data = await fs.promises.readFile(filePath);
    const endTime = perfNow();

    return {
      operation: 'fs.readFile',
      path: filePath,
      startTime,
      endTime,
      duration: endTime - startTime,
      bytesTransferred: data.length,
    };
  } catch (error) {
    const endTime = perfNow();
    return {
      operation: 'fs.readFile',
      path: filePath,
      startTime,
      endTime,
      duration: endTime - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function measureFileWrite(filePath: string, data: Buffer | string): Promise<IOPerformanceMetrics> {
  const startTime = perfNow();

  try {
    await fs.promises.writeFile(filePath, data);
    const endTime = perfNow();

    return {
      operation: 'fs.writeFile',
      path: filePath,
      startTime,
      endTime,
      duration: endTime - startTime,
      bytesTransferred: Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, 'utf8'),
    };
  } catch (error) {
    const endTime = perfNow();
    return {
      operation: 'fs.writeFile',
      path: filePath,
      startTime,
      endTime,
      duration: endTime - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function withPerf<T>(
  name: string,
  fn: () => Promise<T> | T,
  onDone?: (ms: number) => void,
) {
  const t0 = perfNow();
  try {
    return await fn();
  } finally {
    const t1 = perfNow();
    try { onDone?.(t1 - t0); } catch {}
  }
}

export interface ProfileSample {
  timestamp: number;
  cpu: NodeJS.CpuUsage;
  memory: NodeJS.MemoryUsage;
  stack?: string[];
}

export interface FunctionCall {
  name: string;
  start: number;
  duration: number;
}

export class PerformanceProfiler {
  private samples: ProfileSample[] = [];
  private interval?: NodeJS.Timeout;
  private isCapturing = false;
  private startTime = 0;
  private functionCalls: FunctionCall[] = [];
  private isEnabled = false;
  private lastCaptureResult: { duration: number; samples: ProfileSample[]; functionCalls: FunctionCall[]; analysis: any } | null = null;
  private ioMetrics: IOPerformanceMetrics[] = [];

  // ── I/O 후킹 원본 저장/상태 ─────────────────────────────
  private hooksInstalled = false;
  // 콜백/스트림 패치 성공 여부(ESM 네임스페이스는 보통 불가)
  private patchedCbReadFile = false;
  private patchedCbWriteFile = false;
  private patchedCreateReadStream = false;
  private patchedCreateWriteStream = false;
  private origFs = {
    promisesReadFile: fs.promises.readFile as typeof fs.promises.readFile,
    promisesWriteFile: fs.promises.writeFile as typeof fs.promises.writeFile,
    promisesReaddir: fs.promises.readdir as typeof fs.promises.readdir,
    promisesStat: fs.promises.stat as typeof fs.promises.stat,
    promisesUnlink: fs.promises.unlink as typeof fs.promises.unlink,
    promisesMkdir: fs.promises.mkdir as typeof fs.promises.mkdir,
    promisesRmdir: (fs.promises as any).rmdir as any,
    promisesRm: (fs.promises as any).rm as any,
    promisesCopyFile: fs.promises.copyFile as typeof fs.promises.copyFile,
    promisesRename: fs.promises.rename as typeof fs.promises.rename,
    promisesAppendFile: fs.promises.appendFile as typeof fs.promises.appendFile,
    cbReadFile: fs.readFile as typeof fs.readFile,
    cbWriteFile: fs.writeFile as typeof fs.writeFile,
    createReadStream: fs.createReadStream as typeof fs.createReadStream,
    createWriteStream: fs.createWriteStream as typeof fs.createWriteStream,
  };
  private vscodeMod: VSCodeModule | null = null;
  private origVscodeFs:
    | {
        readFile?: VSCodeModule['workspace']['fs']['readFile'];
        writeFile?: VSCodeModule['workspace']['fs']['writeFile'];
        stat?: VSCodeModule['workspace']['fs']['stat'];
        readDirectory?: VSCodeModule['workspace']['fs']['readDirectory'];
        createDirectory?: VSCodeModule['workspace']['fs']['createDirectory'];
        delete?: VSCodeModule['workspace']['fs']['delete'];
        copy?: VSCodeModule['workspace']['fs']['copy'];
        rename?: VSCodeModule['workspace']['fs']['rename'];
      }
    | null = null;

  public enable() {
    this.isEnabled = true;
    this.installHooks();
  }

  public disable() {
    this.uninstallHooks();
    this.isEnabled = false;
  }

  /** 외부에서 OFF/ON 빠른 분기용 (측정 오버헤드 최소화) */
  public isOn(): boolean { return this.isEnabled; }

  /** 외부에서 동기 함수 계측 결과를 기록할 수 있도록 공개 메서드 추가 */
  public recordFunctionCall(name: string, start: number, duration: number) {
    if (!this.isEnabled) return;
    this.functionCalls.push({ name, start, duration });
  }

  public async measureFunction<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    if (!this.isEnabled) return fn();
    const start = perfNow();
    try {
      return await fn();
    } finally {
      const duration = perfNow() - start;
      this.functionCalls.push({ name, start, duration });
    }
  }

  public startCapture() {
    if (this.isCapturing || !this.isEnabled) return;
    this.isCapturing = true;
    this.samples = [];
    this.functionCalls = [];
    this.ioMetrics = [];
    this.startTime = perfNow();
    this.interval = setInterval(() => {
      const sample: ProfileSample = {
        timestamp: perfNow(),
        cpu: process.cpuUsage(),
        memory: process.memoryUsage(),
      };
      this.samples.push(sample);
    }, 100);
  }

  // ── 자동 I/O 후킹(ON 시 설치, OFF 시 원복) ────────────────────────────────
  private installHooks() {
    if (this.hooksInstalled) return;
    const self = this;
    const fsAny: any = fs; // ESM 네임스페이스 보호 회피용(런타임에서 실패하면 try/catch)

    // ---- helpers ----
    const recOk = (operation: string, path: any, start: number, end: number, bytes?: number) =>
      self.recordIOMetrics({
        operation, path: pathToString(path), startTime: start, endTime: end, duration: end - start,
        bytesTransferred: typeof bytes === 'number' ? bytes : undefined,
      });
    const recErr = (operation: string, path: any, start: number, end: number, err: unknown) =>
      self.recordIOMetrics({
        operation, path: pathToString(path), startTime: start, endTime: end, duration: end - start,
        error: err instanceof Error ? err.message : String(err),
      });

    // ---- fs.promises 기본 I/O ----
    const wrapP = <T extends Function>(op: string, orig: any) => {
      return async function patched(path: any, ...rest: any[]) {
        // 후킹은 enable()시에만 설치되므로, OFF일 때 여기로 들어오지 않음 (무부하 보장)
        const start = perfNow();
        try {
          const ret = await orig.call(fs.promises, path, ...rest);
          const end = perfNow();
          let bytes: number | undefined = undefined;
          if (op === 'readFile' && (ret as any)?.length != null) bytes = (ret as any).length;
          if (op === 'writeFile' || op === 'appendFile') {
            const data = rest[0];
            bytes = Buffer.isBuffer(data) ? data.length :
                    typeof data === 'string' ? Buffer.byteLength(data, 'utf8') :
                    (data?.length ?? data?.byteLength);
          }
          recOk(`fs.${op}`, path, start, end, typeof bytes === 'number' ? bytes : undefined);
          return ret;
        } catch (e) {
          const end = perfNow();
          recErr(`fs.${op}`, path, start, end, e);
          throw e;
        }
      };
    };
    fs.promises.readFile = wrapP('readFile', this.origFs.promisesReadFile) as any;
    fs.promises.writeFile = wrapP('writeFile', this.origFs.promisesWriteFile) as any;
    fs.promises.appendFile = wrapP('appendFile', this.origFs.promisesAppendFile) as any;
    fs.promises.readdir = wrapP('readdir', this.origFs.promisesReaddir) as any;
    fs.promises.stat = wrapP('stat', this.origFs.promisesStat) as any;
    fs.promises.unlink = wrapP('unlink', this.origFs.promisesUnlink) as any;
    fs.promises.mkdir = wrapP('mkdir', this.origFs.promisesMkdir) as any;
    if (this.origFs.promisesRmdir) (fs.promises as any).rmdir = wrapP('rmdir', this.origFs.promisesRmdir) as any;
    if (this.origFs.promisesRm) (fs.promises as any).rm = wrapP('rm', this.origFs.promisesRm) as any;
    fs.promises.copyFile = wrapP('copyFile', this.origFs.promisesCopyFile) as any;
    fs.promises.rename = wrapP('rename', this.origFs.promisesRename) as any;

    // ---- 콜백 버전 readFile/writeFile (가능한 런타임에서만 패치) ----
    try {
      fsAny.readFile = function patchedReadFile(path: any, options: any, cb?: any) {
        const hasOpts = typeof options !== 'function';
        const realCb = hasOpts ? cb : options;
        const start = perfNow();
        return (self.origFs.cbReadFile as any).call(
          fs,
          path,
          hasOpts ? options : undefined,
          function onDone(err: any, data: any) {
            const end = perfNow();
            if (err) recErr('fs.readFile(cb)', path, start, end, err);
            else recOk('fs.readFile(cb)', path, start, end, data?.length);
            return realCb?.(err, data);
          },
        );
      };
      this.patchedCbReadFile = true;
    } catch { /* ESM 네임스페이스 등으로 패치 불가 → 무시 */ }

    try {
      fsAny.writeFile = function patchedWriteFile(path: any, data: any, options: any, cb?: any) {
        const withOpts =
          typeof options !== 'function'
            ? { options, cb }
            : { options: undefined, cb: options };
        const start = perfNow();
        return (self.origFs.cbWriteFile as any).call(
          fs,
          path,
          data,
          withOpts.options,
          function onDone(err: any) {
            const end = perfNow();
            const bytes =
              Buffer.isBuffer(data) ? data.length :
              typeof data === 'string' ? Buffer.byteLength(data, 'utf8') :
              (data?.length ?? data?.byteLength);
            if (err) recErr('fs.writeFile(cb)', path, start, end, err);
            else recOk('fs.writeFile(cb)', path, start, end, bytes);
            return withOpts.cb?.(err);
          },
        );
      };
      this.patchedCbWriteFile = true;
    } catch { /* 패치 불가 → 무시 */ }

    // ---- 스트림 read/write ----
    try {
      fsAny.createReadStream = function patchedCRS(path: any, options?: any) {
        const start = perfNow();
        let bytes = 0;
        const s = (self.origFs.createReadStream as any).call(fs, path, options);
        let finalized = false;
        const finalize = (err?: any) => {
          if (finalized) return;
          finalized = true;
          const end = perfNow();
          if (err) recErr('fs.readStream', path, start, end, err);
          else recOk('fs.readStream', path, start, end, bytes);
        };
        s.on('data', (chunk: any) => { try { bytes += chunk?.length ?? 0; } catch {} });
        s.on('end', finalize);
        s.on('close', finalize);
        s.on('error', (e: any) => finalize(e));
        return s;
      };
      this.patchedCreateReadStream = true;
    } catch { /* 패치 불가 → 무시 */ }

    try {
      fsAny.createWriteStream = function patchedCWS(path: any, options?: any) {
        const start = perfNow();
        let bytes = 0;
        const s: any = (self.origFs.createWriteStream as any).call(fs, path, options);
        const origWrite = s.write;
        s.write = function patchedWrite(chunk: any, ...rest: any[]) {
          try { bytes += chunk?.length ?? 0; } catch {}
          return origWrite.call(this, chunk, ...rest);
        };
        const finalize = (err?: any) => {
          const end = perfNow();
          if (err) recErr('fs.writeStream', path, start, end, err);
          else recOk('fs.writeStream', path, start, end, bytes);
        };
        s.on('finish', () => finalize());
        s.on('close', () => finalize());
        s.on('error', (e: any) => finalize(e));
        return s;
      };
      this.patchedCreateWriteStream = true;
    } catch { /* 패치 불가 → 무시 */ }

    // ---- vscode.workspace.fs ----
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.vscodeMod = require('vscode') as VSCodeModule;
      const vfs = this.vscodeMod.workspace?.fs;
      if (vfs) {
        this.origVscodeFs = {
          readFile: vfs.readFile.bind(vfs),
          writeFile: vfs.writeFile.bind(vfs),
          stat: vfs.stat?.bind(vfs),
          readDirectory: vfs.readDirectory?.bind(vfs),
          createDirectory: vfs.createDirectory?.bind(vfs),
          delete: vfs.delete?.bind(vfs),
          copy: vfs.copy?.bind(vfs),
          rename: vfs.rename?.bind(vfs),
        };
        const wrapV = (op: string, orig?: Function) => orig ? (async (uri: any, ...rest: any[]) => {
          // OFF일 땐 후킹이 제거되므로 이 경로가 호출되지 않음
          const start = perfNow();
          try {
            const ret = await orig(uri, ...rest);
            const end = perfNow();
            let bytes: number | undefined;
            if (op === 'readFile') bytes = (ret as Uint8Array)?.byteLength ?? undefined;
            if (op === 'writeFile') bytes = (rest?.[0] as Uint8Array)?.byteLength ?? undefined;
            recOk(`vscode.${op}`, uri, start, end, bytes);
            return ret;
          } catch (e) {
            const end = perfNow();
            recErr(`vscode.${op}`, uri, start, end, e);
            throw e;
          }
        }) : undefined;
        if (this.origVscodeFs.readFile) vfs.readFile = wrapV('readFile', this.origVscodeFs.readFile) as any;
        if (this.origVscodeFs.writeFile) vfs.writeFile = wrapV('writeFile', this.origVscodeFs.writeFile) as any;
        if (this.origVscodeFs.stat) vfs.stat = wrapV('stat', this.origVscodeFs.stat) as any;
        if (this.origVscodeFs.readDirectory) vfs.readDirectory = wrapV('readDirectory', this.origVscodeFs.readDirectory) as any;
        if (this.origVscodeFs.createDirectory) vfs.createDirectory = wrapV('createDirectory', this.origVscodeFs.createDirectory) as any;
        if (this.origVscodeFs.delete) vfs.delete = wrapV('delete', this.origVscodeFs.delete) as any;
        if (this.origVscodeFs.copy) vfs.copy = wrapV('copy', this.origVscodeFs.copy) as any;
        if (this.origVscodeFs.rename) vfs.rename = wrapV('rename', this.origVscodeFs.rename) as any;
      }
    } catch { /* vscode 없음(테스트) */ }

    this.hooksInstalled = true;
  }

  private uninstallHooks() {
    if (!this.hooksInstalled) return;
    const fsAny: any = fs;
    // fs 복원
    fs.promises.readFile = this.origFs.promisesReadFile;
    fs.promises.writeFile = this.origFs.promisesWriteFile;
    fs.promises.readdir = this.origFs.promisesReaddir;
    fs.promises.stat = this.origFs.promisesStat;
    fs.promises.unlink = this.origFs.promisesUnlink;
    fs.promises.mkdir = this.origFs.promisesMkdir;
    if (this.origFs.promisesRmdir) (fs.promises as any).rmdir = this.origFs.promisesRmdir;
    if (this.origFs.promisesRm) (fs.promises as any).rm = this.origFs.promisesRm;
    fs.promises.copyFile = this.origFs.promisesCopyFile;
    fs.promises.rename = this.origFs.promisesRename;
    fs.promises.appendFile = this.origFs.promisesAppendFile;
    try { if (this.patchedCbReadFile) fsAny.readFile = this.origFs.cbReadFile; } catch {}
    try { if (this.patchedCbWriteFile) fsAny.writeFile = this.origFs.cbWriteFile; } catch {}
    try { if (this.patchedCreateReadStream) fsAny.createReadStream = this.origFs.createReadStream; } catch {}
    try { if (this.patchedCreateWriteStream) fsAny.createWriteStream = this.origFs.createWriteStream; } catch {}
    this.patchedCbReadFile = this.patchedCbWriteFile = false;
    this.patchedCreateReadStream = this.patchedCreateWriteStream = false;

    // vscode.workspace.fs 복원
    try {
      if (this.vscodeMod && this.origVscodeFs) {
        const vfs = this.vscodeMod.workspace.fs;
        if (this.origVscodeFs.readFile) vfs.readFile = this.origVscodeFs.readFile as any;
        if (this.origVscodeFs.writeFile) vfs.writeFile = this.origVscodeFs.writeFile as any;
        if (this.origVscodeFs.stat) vfs.stat = this.origVscodeFs.stat as any;
        if (this.origVscodeFs.readDirectory) vfs.readDirectory = this.origVscodeFs.readDirectory as any;
        if (this.origVscodeFs.createDirectory) vfs.createDirectory = this.origVscodeFs.createDirectory as any;
        if (this.origVscodeFs.delete) vfs.delete = this.origVscodeFs.delete as any;
        if (this.origVscodeFs.copy) vfs.copy = this.origVscodeFs.copy as any;
        if (this.origVscodeFs.rename) vfs.rename = this.origVscodeFs.rename as any;
      }
    } catch {}
    this.hooksInstalled = false;
  }

  public stopCapture(): { duration: number; samples: ProfileSample[]; functionCalls: FunctionCall[]; analysis: any } {
    if (!this.isCapturing) return this.lastCaptureResult || { duration: 0, samples: [], functionCalls: [], analysis: {} };
    this.isCapturing = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    const duration = perfNow() - this.startTime;
    const analysis = this.analyzeSamples();
    const result = { duration, samples: this.samples, functionCalls: this.functionCalls, analysis };
    this.lastCaptureResult = result;
    return result;
  }

  public getLastCaptureResult(): { duration: number; samples: ProfileSample[]; functionCalls: FunctionCall[]; analysis: any } {
    return this.lastCaptureResult || { duration: 0, samples: [], functionCalls: [], analysis: {} };
  }

  public recordIOMetrics(metrics: IOPerformanceMetrics) {
    if (this.isCapturing) {
      this.ioMetrics.push(metrics);
    }
  }

  public async measureIO<T>(
    operation: string,
    path: string,
    fn: () => Promise<T>
  ): Promise<T> {
    if (!this.isEnabled) return fn();  // ✅ Off면 그냥 실행 (오버헤드 없음)
    const startTime = perfNow();
    try {
      const result = await fn();
      const endTime = perfNow();

      const metrics: IOPerformanceMetrics = {
        operation,
        path,
        startTime,
        endTime,
        duration: endTime - startTime,
      };

      this.recordIOMetrics(metrics);
      return result;
    } catch (error) {
      const endTime = perfNow();

      const metrics: IOPerformanceMetrics = {
        operation,
        path,
        startTime,
        endTime,
        duration: endTime - startTime,
        error: error instanceof Error ? error.message : String(error),
      };

      this.recordIOMetrics(metrics);
      throw error;
    }
  }

  private analyzeSamples() {
    if (this.samples.length === 0) return {};
    // CPU: process.cpuUsage()는 누적값(µs) → 샘플 간 델타를 ms로 환산
    const cpuUserDeltaMs: number[] = [];
    const cpuSystemDeltaMs: number[] = [];
    const memory = this.samples.map(s => s.memory.heapUsed);
    for (let i = 1; i < this.samples.length; i++) {
      const prev = this.samples[i - 1];
      const curr = this.samples[i];
      cpuUserDeltaMs.push((curr.cpu.user - prev.cpu.user) / 1000);
      cpuSystemDeltaMs.push((curr.cpu.system - prev.cpu.system) / 1000);
    }
    const functionSummary = this.functionCalls.reduce((acc, call) => {
      if (!acc[call.name]) acc[call.name] = { count: 0, totalTime: 0, avgTime: 0, maxTime: 0 };
      acc[call.name].count++;
      acc[call.name].totalTime += call.duration;
      acc[call.name].maxTime = Math.max(acc[call.name].maxTime, call.duration);
      acc[call.name].avgTime = acc[call.name].totalTime / acc[call.name].count;
      return acc;
    }, {} as Record<string, { count: number; totalTime: number; avgTime: number; maxTime: number }>);

    // I/O 성능 분석
    const ioAnalysis = this.analyzeIOMetrics();

    // 자동 병목 감지 (I/O 정보 추가)
    const bottlenecks = this.detectBottlenecks(functionSummary, memory, ioAnalysis);

    // 성능 인사이트 (I/O 정보 추가)
    const insights = this.generateInsights(functionSummary, bottlenecks, ioAnalysis);

    return {
      totalSamples: this.samples.length,
      // 델타 기반(ms)
      avgCpuUser: cpuUserDeltaMs.length ? cpuUserDeltaMs.reduce((a, b) => a + b, 0) / cpuUserDeltaMs.length : 0,
      avgCpuSystem: cpuSystemDeltaMs.length ? cpuSystemDeltaMs.reduce((a, b) => a + b, 0) / cpuSystemDeltaMs.length : 0,
      maxCpuUser: cpuUserDeltaMs.length ? Math.max(...cpuUserDeltaMs) : 0,
      maxCpuSystem: cpuSystemDeltaMs.length ? Math.max(...cpuSystemDeltaMs) : 0,
      avgMemory: memory.reduce((a, b) => a + b, 0) / memory.length,
      maxMemory: Math.max(...memory),
      minMemory: Math.min(...memory),
      functionSummary,
      ioMetrics: this.ioMetrics,
      ioAnalysis,
      bottlenecks,
      insights,
    };
  }

  private detectBottlenecks(functionSummary: Record<string, any>, memory: number[], ioAnalysis: any) {
    const bottlenecks = { slowFunctions: [] as string[], highMemoryUsage: false, slowIO: false };
    const avgMemory = memory.reduce((a, b) => a + b, 0) / memory.length;
    const maxMemory = Math.max(...memory);

    // 평균보다 2배 이상 느린 함수
    const allAvgTimes = Object.values(functionSummary).map((s: any) => s.avgTime);
    const overallAvg = allAvgTimes.length ? (allAvgTimes.reduce((a, b) => a + b, 0) / allAvgTimes.length) : 0;
    bottlenecks.slowFunctions = Object.entries(functionSummary)
      .filter(([_, stats]: [string, any]) => stats.avgTime > overallAvg * 2)
      .map(([name]) => name);

    // 메모리 사용량이 높은 경우
    bottlenecks.highMemoryUsage = maxMemory > avgMemory * 1.5;

    // I/O가 느린 경우 (100ms 이상) — 모든 op 평균시간을 스캔
    const perOp = ioAnalysis?.perOp || {};
    bottlenecks.slowIO = Object.values(perOp).some((s: any) => (s?.avgDuration ?? 0) > 100);

    return bottlenecks;
  }

  private analyzeIOMetrics() {
    if (this.ioMetrics.length === 0) return { perOp: {}, totalOperations: 0, totalIOTime: 0 };
    const perOp = new Map<string, IOPerformanceMetrics[]>();
    for (const m of this.ioMetrics) {
      const arr = perOp.get(m.operation) || [];
      arr.push(m);
      perOp.set(m.operation, arr);
    }
    const summarize = (ops: IOPerformanceMetrics[]) => {
      const durations = ops.map(o => o.duration);
      const totalTime = durations.reduce((a, b) => a + b, 0);
      const errors = ops.filter(o => o.error).length;
      const avgDuration = totalTime / (durations.length || 1);
      const maxDuration = Math.max(...durations);
      const totalBytes = ops.map(o => o.bytesTransferred || 0).reduce((a, b) => a + b, 0);
      return { count: ops.length, avgDuration, maxDuration, totalTime, errors, totalBytes };
    };
    const out: Record<string, any> = {};
    for (const [op, arr] of perOp) out[op] = summarize(arr);
    const totalOperations = this.ioMetrics.length;
    const totalIOTime = this.ioMetrics.reduce((sum, m) => sum + m.duration, 0);
    return { perOp: out, totalOperations, totalIOTime };
  }

  private generateInsights(functionSummary: Record<string, any>, bottlenecks: any, ioAnalysis: any) {
    const insights = [];
    // I/O 비중 안내
    if (ioAnalysis.totalOperations > 0) {
      const totalTime =
        this.samples.length > 0
          ? this.samples[this.samples.length - 1].timestamp - this.samples[0].timestamp
          : (functionSummary ? Object.values(functionSummary).reduce((s: number, f: any) => s + (f.totalTime || 0), 0) : 0);
      const ioPct = totalTime > 0 ? (ioAnalysis.totalIOTime / totalTime) * 100 : 0;
      insights.push(`I/O time share: ${ioPct.toFixed(1)}%`);
    }
    // 에러 요약
    if (ioAnalysis?.perOp) {
      const errOps = Object.entries(ioAnalysis.perOp).filter(([, s]: any) => s.errors > 0).map(([k]) => k);
      if (errOps.length) insights.push(`I/O errors on: ${errOps.join(', ')}`);
    }

    if (bottlenecks.slowFunctions.length > 0) {
      insights.push(`병목 함수들: ${bottlenecks.slowFunctions.join(', ')} - 최적화 필요`);
    }
    if (bottlenecks.highMemoryUsage) {
      insights.push('메모리 사용량이 높음 - 메모리 누수 확인 필요');
    }
    if (bottlenecks.slowIO) {
      insights.push('I/O 작업이 느림 - 파일 시스템 최적화 고려');
    }

    // I/O가 매우 느린 연산
    if (ioAnalysis?.perOp) {
      const slowOps = Object.entries(ioAnalysis.perOp)
        .filter(([, s]: any) => (s.avgDuration ?? 0) > 100)
        .map(([k]) => `${k}(${(ioAnalysis.perOp[k].avgDuration).toFixed(1)}ms)`);
      if (slowOps.length) insights.push(`느린 I/O: ${slowOps.join(', ')}`);
    }

    const totalCalls = Object.values(functionSummary).reduce((sum: number, s: any) => sum + s.count, 0);
    if (totalCalls > LOG_TOTAL_CALLS_THRESHOLD) {
      insights.push('함수 호출 수가 많음 - 캐싱 고려');
    }
    return insights;
  }

}

export const globalProfiler = new PerformanceProfiler();

// Decorator for class methods
export function measure(name?: string) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    // 원본 메서드가 async 인지 여부를 판별해 시그니처를 보존
    const isAsync =
      originalMethod &&
      (originalMethod.constructor?.name === 'AsyncFunction' ||
        // 간혹 transpile 단계에서 name 이 바뀌는 경우를 위한 보조 체크
        /\basync\b/.test(Function.prototype.toString.call(originalMethod)));

    if (isAsync) {
      descriptor.value = async function (...args: any[]) {
        const funcName = name || propertyKey;
        // 🔴 OFF: 측정 없이 즉시 원본 실행 → 타이머 호출 0회
        if (!globalProfiler.isOn()) return originalMethod.apply(this, args);
        // 🟢 ON: 타이머 & 기록
        const t0 = perfNow();
        try { return await originalMethod.apply(this, args); }
        finally { globalProfiler.recordFunctionCall(funcName, t0, perfNow() - t0); }
      };
    } else {
      descriptor.value = function (...args: any[]) {
        const funcName = name || propertyKey;
        // 🔴 OFF: 측정 없이 즉시 원본 실행 → 타이머 호출 0회
        if (!globalProfiler.isOn()) return originalMethod.apply(this, args);
        // 🟢 ON: 타이머 & 기록
        const t0 = perfNow();
        try { return originalMethod.apply(this, args); }
        finally { globalProfiler.recordFunctionCall(funcName, t0, perfNow() - t0); }
      };
    }
    return descriptor;
  };
}

export interface MemorySnapshot {
  timestamp: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
  arrayBuffers?: number;
  stack?: string;
}

export function takeMemorySnapshot(label?: string): MemorySnapshot {
  const memUsage = process.memoryUsage();
  const snapshot: MemorySnapshot = {
    timestamp: perfNow(),
    heapUsed: memUsage.heapUsed,
    heapTotal: memUsage.heapTotal,
    external: memUsage.external,
    rss: memUsage.rss,
  };

  // V8 heap statistics if available
  try {
    const v8 = require('v8');
    const heapStats = v8.getHeapStatistics();
    snapshot.arrayBuffers = heapStats.total_array_buffer_size || 0;
  } catch (e) {
    // v8 module not available or heap stats not supported
  }

  // Add stack trace for debugging
  if (label) {
    const err = new Error();
    Error.captureStackTrace(err);
    snapshot.stack = err.stack;
  }

  return snapshot;
}

/* ─────────────────────────────────────────────────────────────
 * 전역/콜백/모듈용 계측 헬퍼 (데코레이터 불가 영역)
 *  - measured / measuredAsync: 함수 자체를 래핑해서 항상 계측
 *  - measureBlock: 호출부에서 블록 단위로 계측
 *  - measureAllMethods: 객체(인스턴스)의 모든 메서드 프록시 계측
 *  - measureAllExports: CJS 모듈의 exports 전체 함수 계측
 *  - enableAutoFsIOMeasure: fs.promises 자동 I/O 계측 패치
 * ───────────────────────────────────────────────────────────── */

export function measured<T extends (...args: any[]) => any>(name: string, fn: T): T {
  const wrapped = function (this: any, ...args: any[]) {
    // 🔴 OFF: 즉시 원본
    if (!globalProfiler.isOn()) return fn.apply(this, args);
    // 🟢 ON: 타이머 & 기록
    const t0 = perfNow();
    try { return fn.apply(this, args); }
    finally { globalProfiler.recordFunctionCall(name, t0, perfNow() - t0); }
  };
  // @ts-ignore
  return wrapped;
}

export function measuredAsync<T extends (...args: any[]) => Promise<any>>(name: string, fn: T): T {
  const wrapped = async function (this: any, ...args: any[]) {
    // 🔴 OFF: 즉시 원본
    if (!globalProfiler.isOn()) return fn.apply(this, args);
    // 🟢 ON: 타이머 & 기록
    const t0 = perfNow();
    try { return await fn.apply(this, args); }
    finally { globalProfiler.recordFunctionCall(name, t0, perfNow() - t0); }
  };
  // @ts-ignore
  return wrapped;
}

// 오버로드: 동기 함수면 T, 비동기면 Promise<T>를 반환하도록 타입 보존
export function measureBlock<T>(name: string, fn: () => T): T;
export function measureBlock<T>(name: string, fn: () => Promise<T>): Promise<T>;
export function measureBlock<T>(name: string, fn: () => T | Promise<T>): T | Promise<T> {
  if (!globalProfiler.isOn()) return fn();
  const t0 = perfNow();
  try {
    const r = fn();
    if (r && typeof (r as any).then === 'function') {
      return (r as Promise<T>).finally(() =>
        globalProfiler.recordFunctionCall(name, t0, perfNow() - t0)
      );
    }
    globalProfiler.recordFunctionCall(name, t0, perfNow() - t0);
    return r as T;
  } catch (e) {
    globalProfiler.recordFunctionCall(name, t0, perfNow() - t0);
    throw e;
  }
}

/** 클래스 인스턴스의 모든 메서드를 프록시로 감싸 전역 계측 */
export function measureAllMethods<T extends object>(obj: T, prefix?: string): T {
  const tag = prefix || (obj as any)?.constructor?.name || 'Object';
  return new Proxy(obj, {
    get(target, p, receiver) {
      const v = Reflect.get(target, p, receiver);
      if (typeof v === 'function' && p !== 'constructor') {
        const name = `${tag}.${String(p)}`;
        return function (this: any, ...args: any[]) {
          // 🔴 OFF: 즉시 원본
          if (!globalProfiler.isOn()) return v.apply(this, args);
          // 🟢 ON: 타이머 & 기록
          const t0 = perfNow();
          try { return v.apply(this, args); }
          finally { globalProfiler.recordFunctionCall(name, t0, perfNow() - t0); }
        };
      }
      return v;
    },
  });
}

/** CommonJS 모듈의 exports 전체를 래핑 (ESM에서는 사용 불가) */
export function measureAllExports(mod: any, prefix = 'module', exclude: string[] = []) {
  try {
    const exp = mod?.exports;
    if (!exp || typeof exp !== 'object') return;
    for (const k of Object.keys(exp)) {
      if (exclude.includes(k)) continue;
      const v = (exp as any)[k];
      if (typeof v === 'function') {
        const name = `${prefix}.${k}`;
        (exp as any)[k] = (v.constructor?.name === 'AsyncFunction')
          ? measuredAsync(name, v as any)
          : measured(name, v as any);
      }
    }
  } catch {
    // ignore
  }
}

/** fs.promises.* 를 자동 계측으로 패치 */
let _fsPatched = false;
export function enableAutoFsIOMeasure() {
  if (_fsPatched) return;
  const wrap = (key: string) => {
    const orig = (fs.promises as any)[key];
    if (typeof orig !== 'function') return;
    (fs.promises as any)[key] = async function (...args: any[]) {
      if (!globalProfiler.isOn()) return orig.apply(this, args);
      const p = typeof args[0] === 'string' ? args[0] : (args[0]?.path || '');
      const op = `fs.${key}`;
      return globalProfiler.measureIO(op, p, () => orig.apply(this, args));
    };
  };
  [
    'readFile', 'writeFile', 'appendFile', 'readdir', 'stat', 'lstat',
    'open', 'unlink', 'mkdir', 'rmdir', 'rm', 'copyFile', 'rename', 'readlink', 'symlink'
  ].forEach(wrap);
  _fsPatched = true;
}
