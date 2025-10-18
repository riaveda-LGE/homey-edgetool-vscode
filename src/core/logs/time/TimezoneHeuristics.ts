// === src/core/logs/time/TimezoneHeuristics.ts ===
import { getLogger } from '../../logging/extension-logger.js';

/**
 * 파일 타입별(Time series 단위) 타임존 점프 보정기.
 * - 병합은 "최신 → 오래된" 순으로 진행된다고 가정한다.
 * - 점프 의심은 직전 rawTs 대비 ≥ MIN_JUMP_HOURS 시간 변화.
 * - "복귀"가 확인되면, suspected 구간에만 국소 소급 보정(Δoffset)을 적용한다.
 * - 복귀 기준은 점프 직전 기준선(preJumpRawTs)과 비교한다.
 * - 복귀 최소 차이(MIN_RETURN_HOURS)로 잡음(수분/수초 변화)을 필터링.
 * - 글로벌 offset 누적은 하지 않음(국소 보정만).
 */
export class TimezoneCorrector {
  private lastCorrected?: number;     // 직전 반환한 보정 ts(단조감소 체크용)
  private lastRawTs?: number;         // 직전 rawTs
  private readonly log = getLogger('TimezoneCorrector');

  // 점프 의심 상태(최대 1건)
  private suspected:
    | {
        startIndex: number;               // 점프 구간 시작 인덱스(현재 라인 인덱스 기준)
        firstJumpRawTs: number;           // 점프가 처음 관측된 rawTs
        preJumpRawTs: number;             // 점프 직전의 rawTs(기준선)
        direction: 'positive' | 'negative';
        hourDiff: number;                 // 점프 크기(시간)
      }
    | undefined;

  // 국소 소급 보정 구간들(mergeDirectory가 소비)
  private retroSegments: { start: number; end: number; deltaMs: number }[] = [];

  // 임계값
  private readonly MIN_JUMP_HOURS = 3;    // 점프 의심 임계값(현행 3h 유지)
  private readonly MIN_RETURN_HOURS = 1;  // 복귀 최소 차이(요청하신 1h)

  constructor(public readonly label: string) {}

  /**
   * 최신→오래된 순으로 rawTs가 들어온다.
   * index는 현재 처리 중인 로그의 인덱스(0부터).
   * 반환: 보정된 ts(국소 보정이 필요한 경우 retroSegments에 구간 enqueue)
   */
  adjust(rawTs: number, index: number): number {
    // 1) suspected가 있으면 "복귀"를 **먼저** 판정 (분기 순서가 핵심!)
    if (this.suspected) {
      const s = this.suspected;
      const hour = 60 * 60 * 1000;
      // ① 점프 꼭짓점에서 최소 1시간 이상 되돌아왔는지
      const movedBackEnough =
        s.direction === 'positive'
          ? (s.firstJumpRawTs - rawTs) >= this.MIN_RETURN_HOURS * hour
          : (rawTs - s.firstJumpRawTs) >= this.MIN_RETURN_HOURS * hour;
      // ② preJump 기준선을 다시 넘었는지
      const crossedBaseline =
        s.direction === 'positive'
          ? rawTs <= s.preJumpRawTs
          : rawTs >= s.preJumpRawTs;
      const returned = movedBackEnough && crossedBaseline;

      if (returned) {
        // 복귀 확정 → suspected 구간(start..index-1)에만 Δoffset 적용하는 retro segment 생성
        // Δoffset은 "가능한 시간대 오프셋(±1h/±9h/±10h/±12h)" 중
        // 감지된 jump 크기(hourDiff)에 가장 가까운 정수 시간으로 스냅한다.
        // 이렇게 하면 기준선(preJumpRawTs)과 '완전히 같은 ts'가 되는 것을 방지.
        const CANDIDATES = [1, 9, 10, 12]; // 허용 시간대 후보(시간)
        const nearest = CANDIDATES.reduce(
          (best, h) =>
            Math.abs(s.hourDiff - h) < Math.abs(s.hourDiff - best) ? h : best,
          CANDIDATES[0],
        );
        const sign = s.direction === 'positive' ? -1 : +1;
        const deltaMs = sign * nearest * hour;

        // index-1 까지가 점프 구간 (현재 rawTs는 복귀 이후의 라인)
        const end = Math.max(s.startIndex, index - 1);
        if (end >= s.startIndex) {
          this.retroSegments.push({ start: s.startIndex, end, deltaMs });
          this.log.info(
            `타임존 점프 판명 [${this.label}]: retro(${s.startIndex}..${end}) Δ=${deltaMs / 3600000}h (nearest)`,
          );
        }

        // suspected 해제 (글로벌 offset 누적은 하지 않음)
        this.suspected = undefined;
        // 이후 로직은 정상 라인 처리로 계속 진행(단조감소 체크 등)
      }
    }

    // 2) 기본 보정값(글로벌 오프셋을 쓰지 않으므로 corrected=rawTs)
    const corrected = rawTs;

    // 3) 단조감소 유지 또는 최초 값 기록
    if (this.lastCorrected === undefined || corrected <= this.lastCorrected) {
      this.lastCorrected = corrected;
      this.lastRawTs = rawTs;
      return corrected;
    }

    // 4) 점프 의심: 직전 rawTs와 ≥ MIN_JUMP_HOURS 시간 차이면 suspected 적재
    if (this.lastRawTs !== undefined) {
      const diffMs = rawTs - this.lastRawTs;
      const hourDiff = Math.abs(diffMs) / (60 * 60 * 1000);
      if (hourDiff >= this.MIN_JUMP_HOURS) {
        // 연속 의심이 들어오더라도 최초 의심만 유지(노이즈 완화)
        if (!this.suspected) {
          const direction: 'positive' | 'negative' = diffMs > 0 ? 'positive' : 'negative';
          this.suspected = {
            startIndex: index,
            firstJumpRawTs: rawTs,
            preJumpRawTs: this.lastRawTs,
            direction,
            hourDiff,
          };
          this.log.info(
            `타임존 점프 의심 [${this.label}]: ${direction} ${hourDiff.toFixed(1)}h @idx=${index} (pre=${new Date(this.lastRawTs).toISOString()} jump=${new Date(rawTs).toISOString()})`,
          );
        }
        this.lastCorrected = corrected;
        this.lastRawTs = rawTs;
        return corrected; // 의심 단계에서는 즉시 보정하지 않음
      }
    }

    // 5) jump가 아니고 corrected > lastCorrected(이상치)면 보수적으로 1ms 클램프
    const clamped = (this.lastCorrected ?? corrected) - 1;
    this.lastCorrected = clamped;
    this.lastRawTs = rawTs;
    this.log.info(`타임존 클램프 [${this.label}]: 1ms, ts=${new Date(clamped).toISOString()}`);
    return clamped;
  }

  /**
   * 테스트/마무리 시 호출: suspected가 남아있으면 폐기(복귀 증거 없으면 적용 금지)
   * 반환: 의심 상태가 있었고 폐기되었는지 여부
   */
  finalizeSuspected(): boolean {
    const had = !!this.suspected;
    if (had) {
      this.log.info(`타임존 suspected 폐기 [${this.label}]: 복귀 증거 없음`);
    }
    this.suspected = undefined;
    return had;
  }

  /**
   * 국소 소급 보정 구간을 한 번에 가져오고 비운다.
   * 각 구간: [start, end] inclusive 에 deltaMs 더하기.
   */
  drainRetroSegments(): { start: number; end: number; deltaMs: number }[] {
    const out = this.retroSegments;
    this.retroSegments = [];
    return out;
  }
}

/** (이전 호환) no-op */
export function identity<T>(v: T): T { return v; }
