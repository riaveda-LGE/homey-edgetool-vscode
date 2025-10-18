// === src/core/logs/time/TimezoneHeuristics.ts ===

/**
 * 파일 타입별(Time series 단위) 타임존 점프 보정기.
 * - 병합은 "최신 → 오래된" 순으로 진행된다고 가정한다.
 * - 과거로 갈수록(rawTs) 시간이 갑자기 "앞으로" 뛰는 경우(older가 newer보다 큼) 오프셋을 조정한다.
 * - Go 버전 참고: 3개 로그 패턴으로 타임존 점프 감지 (현재-이전 ≥ 3시간 + 다음 복귀)
 * - 후보 오프셋: ±1h, ±9h, ±10h, ±12h (현장 이슈에 흔한 점프 폭)
 * - 불가피하면 이전 보정값보다 1ms 더 과거로 클램프해 단조 감소 보장.
 */
export class TimezoneCorrector {
  private lastCorrected?: number;
  private offsetMs = 0;
  private readonly candidates: number[] = [
    0,
    -1 * 60 * 60 * 1000, +1 * 60 * 60 * 1000,
    -9 * 60 * 60 * 1000, +9 * 60 * 60 * 1000,
    -10 * 60 * 60 * 1000, +10 * 60 * 60 * 1000,
    -12 * 60 * 60 * 1000, +12 * 60 * 60 * 1000,
  ];
  
  // Go 버전 패턴 감지용: 최근 3개 raw 타임스탬프 버퍼
  private recentRawTs: number[] = [];
  private readonly PATTERN_THRESHOLD_HOURS = 3; // 3시간 임계값

  constructor(public readonly label: string) {}

  /** 최신→오래된 순으로 rawTs가 들어온다. 반환은 "보정된 ts" */
  adjust(rawTs: number): number {
    // Go 버전 패턴 감지: 최근 3개 raw 타임스탬프 유지
    this.recentRawTs.push(rawTs);
    if (this.recentRawTs.length > 3) {
      this.recentRawTs.shift(); // 오래된 것 제거
    }

    const corrected = rawTs + this.offsetMs;
    if (this.lastCorrected === undefined) {
      this.lastCorrected = corrected;
      return corrected;
    }
    if (corrected <= this.lastCorrected) {
      this.lastCorrected = corrected;
      return corrected;
    }

    // Go 버전 스타일 점프 감지: 시간 차이가 3시간 이상이면 타임존 점프 의심
    if (this.recentRawTs.length >= 2) {
      const prevRawTs = this.recentRawTs[this.recentRawTs.length - 2];
      const hourDiff = Math.abs((rawTs - prevRawTs) / (60 * 60 * 1000));
      if (hourDiff >= this.PATTERN_THRESHOLD_HOURS) {
        console.log(`[${this.label}] Timezone jump detected: ${hourDiff.toFixed(1)}h diff, applying -9h offset`);
        // 타임존 점프 패턴 감지: -9시간 오프셋 적용 (KST → UTC)
        const tzOffset = -9 * 60 * 60 * 1000;
        const tzCorrected = rawTs + this.offsetMs + tzOffset;
        if (tzCorrected <= this.lastCorrected) {
          this.offsetMs += tzOffset;
          this.lastCorrected = tzCorrected;
          return tzCorrected;
        }
      }
    }

    // jump 감지됨: 후보 오프셋을 탐색해 단조감소 만족 & 가장 가까운 값 선택
    let best: { corr: number; off: number } | null = null;
    for (const delta of this.candidates) {
      const off = this.offsetMs + delta;
      const corr = rawTs + off;
      if (corr <= this.lastCorrected) {
        if (!best || corr > best.corr) {
          best = { corr, off };
        }
      }
    }

    if (best) {
      this.offsetMs = best.off;
      this.lastCorrected = best.corr;
      return best.corr;
    }

    // 어떤 오프셋으로도 단조감소를 못 맞추면 1ms 클램프(보수적)
    const clamped = this.lastCorrected - 1;
    this.lastCorrected = clamped;
    return clamped;
  }
}

/** (이전 호환) no-op */
export function identity<T>(v: T): T { return v; }
