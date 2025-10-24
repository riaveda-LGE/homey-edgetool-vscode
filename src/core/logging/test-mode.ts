// === src/core/logging/test-mode.ts ===
/**
 * npm run test / 테스트 러너 환경 감지.
 * - npm_lifecycle_event === 'test'
 * - NODE_ENV === 'test'
 * - 비테스트/제스트 런타임 힌트(VITEST/JEST_WORKER_ID)
 * - 강제 스위치: EDGE_TOOL_LOG_TO_CONSOLE=1
 */
export function isTestMode(): boolean {
  const ev = (process.env.npm_lifecycle_event || '').toLowerCase();
  if (process.env.EDGE_TOOL_LOG_TO_CONSOLE === '1') return true;
  return (
    ev === 'test' ||
    process.env.NODE_ENV === 'test' ||
    !!process.env.VITEST ||
    !!process.env.JEST_WORKER_ID
  );
}
