// === src/shared/utils.ts ===
export function safeJson<T>(v: T): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
export function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}
