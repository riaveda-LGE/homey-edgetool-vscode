// === src/core/logging/perf.ts ===
export function perfNow() {
  const [s, ns] = process.hrtime();
  return s * 1e3 + ns / 1e6;
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

    // 자동 병목 감지
    const bottlenecks = this.detectBottlenecks(functionSummary, memory);

    // 성능 인사이트
    const insights = this.generateInsights(functionSummary, bottlenecks);

    // Flame Graph 데이터 (간단한 스택 트레이스 기반)
    const flameGraph = this.generateFlameGraph(this.functionCalls);

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
      bottlenecks,
      insights,
      flameGraph,
    };
  }

  private detectBottlenecks(functionSummary: Record<string, any>, memory: number[]) {
    const bottlenecks = { slowFunctions: [] as string[], highMemoryUsage: false };
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

    return bottlenecks;
  }

  private generateInsights(functionSummary: Record<string, any>, bottlenecks: any) {
    const insights = [];
    if (bottlenecks.slowFunctions.length > 0) {
      insights.push(`병목 함수들: ${bottlenecks.slowFunctions.join(', ')} - 최적화 필요`);
    }
    if (bottlenecks.highMemoryUsage) {
      insights.push('메모리 사용량이 높음 - 메모리 누수 확인 필요');
    }
    const totalCalls = Object.values(functionSummary).reduce((sum: number, s: any) => sum + s.count, 0);
    if (totalCalls > 1000) {
      insights.push('함수 호출 수가 많음 - 캐싱 고려');
    }
    return insights;
  }

  private generateFlameGraph(functionCalls: FunctionCall[]) {
    // 간단한 Flame Graph 데이터 생성 (스택 기반)
    const stacks = functionCalls.map(call => ({
      name: call.name,
      value: call.duration,
      children: [] // 실제 스택 트레이스가 없으므로 단순화
    }));
    return { name: 'root', children: stacks };
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
