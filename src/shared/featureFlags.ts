// === src/shared/featureFlags.ts ===
// 프로덕트 기본값(빌드 타임 고정). 테스트에서는 아래 setter로만 오버라이드 허용.

export const LOG_WARMUP_ENABLED_DEFAULT = true;   // 프로덕트 기본: 워밍업 사용
export const LOG_WARMUP_PER_TYPE_LIMIT_DEFAULT = 10000;
export const LOG_WARMUP_TARGET_DEFAULT = 10000;    // 최초 방출 목표치(가상 스크롤용 10,000)
export const LOG_WRITE_RAW_DEFAULT = false;       // 프로덕트 기본: RAW(JSONL) 기록 비활성화

let _warmupEnabled = LOG_WARMUP_ENABLED_DEFAULT;
let _warmupPerTypeLimit = LOG_WARMUP_PER_TYPE_LIMIT_DEFAULT;
let _warmupTarget = LOG_WARMUP_TARGET_DEFAULT;
// ENV(HOMEY_WRITE_RAW) 로 초기값 오버라이드 가능: "1" | "true" | "yes" | "on" → true
let _writeRaw = (() => {
  try {
    // node 환경 외에도 보호적으로 접근
    const v = (typeof process !== 'undefined' && (process as any)?.env?.HOMEY_WRITE_RAW) as string | undefined;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
      if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
    }
  } catch {}
  return LOG_WRITE_RAW_DEFAULT;
})();

export const Flags = {
  get warmupEnabled() { return _warmupEnabled; },
  get warmupPerTypeLimit() { return _warmupPerTypeLimit; },
  get warmupTarget() { return _warmupTarget; },
  /** RAW(JSONL) 기록 여부 */
  get writeRaw() { return _writeRaw; },
};

// ⛔️ 프로덕트 코드에서 호출 금지. 테스트 전용 오버라이드 API.
export function __setWarmupFlagsForTests(opts: {
  warmupEnabled?: boolean;
  warmupPerTypeLimit?: number;
  warmupTarget?: number;
  /** 테스트에서 RAW 기록을 강제로 on/off */
  writeRaw?: boolean;
}) {
  if (typeof opts.warmupEnabled === 'boolean') _warmupEnabled = opts.warmupEnabled;
  if (typeof opts.warmupPerTypeLimit === 'number') _warmupPerTypeLimit = opts.warmupPerTypeLimit;
  if (typeof opts.warmupTarget === 'number') _warmupTarget = opts.warmupTarget;
  if (typeof opts.writeRaw === 'boolean') _writeRaw = opts.writeRaw;
}
