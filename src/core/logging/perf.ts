// === src/core/logging/perf.ts ===
import * as fs from 'fs';

import { LOG_TOTAL_CALLS_THRESHOLD } from '../../shared/const.js';

export function perfNow() {
  const [s, ns] = process.hrtime();
  return s * 1e3 + ns / 1e6;
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

// I/O 성능 측정 함수들
export async function measureFileRead(filePath: string): Promise<IOPerformanceMetrics> {
  const startTime = perfNow();

  try {
    const data = await fs.promises.readFile(filePath);
    const endTime = perfNow();

    return {
      operation: 'readFile',
      path: filePath,
      startTime,
      endTime,
      duration: endTime - startTime,
      bytesTransferred: data.length,
    };
  } catch (error) {
    const endTime = perfNow();
    return {
      operation: 'readFile',
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
      operation: 'writeFile',
      path: filePath,
      startTime,
      endTime,
      duration: endTime - startTime,
      bytesTransferred: Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, 'utf8'),
    };
  } catch (error) {
    const endTime = perfNow();
    return {
      operation: 'writeFile',
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
  const ret = await fn();
  const t1 = perfNow();
  onDone?.(t1 - t0);
  return ret;
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

  public enable() {
    this.isEnabled = true;
  }

  public disable() {
    this.isEnabled = false;
  }

  public async measureFunction<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    if (!this.isEnabled) return fn();
    const start = perfNow();
    const ret = await fn();
    const duration = perfNow() - start;
    this.functionCalls.push({ name, start, duration });
    return ret;
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
    const cpuUser = this.samples.map(s => s.cpu.user);
    const cpuSystem = this.samples.map(s => s.cpu.system);
    const memory = this.samples.map(s => s.memory.heapUsed);
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
      avgCpuUser: cpuUser.reduce((a, b) => a + b, 0) / cpuUser.length,
      avgCpuSystem: cpuSystem.reduce((a, b) => a + b, 0) / cpuSystem.length,
      maxCpuUser: Math.max(...cpuUser),
      maxCpuSystem: Math.max(...cpuSystem),
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
    const overallAvg = allAvgTimes.reduce((a, b) => a + b, 0) / allAvgTimes.length;
    bottlenecks.slowFunctions = Object.entries(functionSummary)
      .filter(([_, stats]: [string, any]) => stats.avgTime > overallAvg * 2)
      .map(([name]) => name);

    // 메모리 사용량이 높은 경우
    bottlenecks.highMemoryUsage = maxMemory > avgMemory * 1.5;

    // I/O가 느린 경우 (100ms 이상)
    if (ioAnalysis.readFile?.avgDuration > 100 || ioAnalysis.writeFile?.avgDuration > 100) {
      bottlenecks.slowIO = true;
    }

    return bottlenecks;
  }

  private analyzeIOMetrics() {
    if (this.ioMetrics.length === 0) return {};

    const readOps = this.ioMetrics.filter(m => m.operation === 'readFile');
    const writeOps = this.ioMetrics.filter(m => m.operation === 'writeFile');

    const analyzeOps = (ops: IOPerformanceMetrics[]) => {
      if (ops.length === 0) return {};
      const durations = ops.map(op => op.duration);
      return {
        count: ops.length,
        avgDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
        maxDuration: Math.max(...durations),
        totalTime: durations.reduce((a, b) => a + b, 0),
        errors: ops.filter(op => op.error).length,
      };
    };

    return {
      readFile: analyzeOps(readOps),
      writeFile: analyzeOps(writeOps),
      totalOperations: this.ioMetrics.length,
      totalIOTime: this.ioMetrics.reduce((sum, m) => sum + m.duration, 0),
    };
  }

  private generateInsights(functionSummary: Record<string, any>, bottlenecks: any, ioAnalysis: any) {
    const insights = [];
    if (bottlenecks.slowFunctions.length > 0) {
      insights.push(`병목 함수들: ${bottlenecks.slowFunctions.join(', ')} - 최적화 필요`);
    }
    if (bottlenecks.highMemoryUsage) {
      insights.push('메모리 사용량이 높음 - 메모리 누수 확인 필요');
    }
    if (bottlenecks.slowIO) {
      insights.push('I/O 작업이 느림 - 파일 시스템 최적화 고려');
    }

    // I/O 성능 인사이트
    if (ioAnalysis.totalOperations > 0) {
      const totalTime = this.samples.length > 0 ?
        (this.samples[this.samples.length - 1].timestamp - this.samples[0].timestamp) : 0;
      const ioTimePercentage = totalTime > 0 ? (ioAnalysis.totalIOTime / totalTime) * 100 : 0;

      if (ioTimePercentage > 50) {
        insights.push(`I/O 시간이 전체의 ${ioTimePercentage.toFixed(1)}% 차지 - I/O 바운드 작업`);
      }

      if (ioAnalysis.readFile?.errors > 0 || ioAnalysis.writeFile?.errors > 0) {
        insights.push('I/O 에러 발생 - 파일 시스템 상태 확인 필요');
      }
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
    descriptor.value = async function (...args: any[]) {
      const funcName = name || propertyKey;
      return globalProfiler.measureFunction(funcName, () => originalMethod.apply(this, args));
    };
    return descriptor;
  };
}

// Decorator for I/O operations
export function measureIO(operation: string, pathGetter: (instance: any) => string) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    descriptor.value = async function (...args: any[]) {
      if (!globalProfiler['isEnabled']) return originalMethod.apply(this, args);  // ✅ Off면 그냥 실행 (오버헤드 없음)
      const path = pathGetter(this);
      return await globalProfiler.measureIO(operation, path, () => originalMethod.apply(this, args));
    };
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
