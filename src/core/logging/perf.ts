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
