// === src/core/logs/time/TimeParser.ts ===
import { measureBlock } from '../../logging/perf.js';

/**
 * 헤더 전용 시간 파서
 * - 입력이 **전체 라인**이면 선두 헤더만 시간 후보로 사용(본문 스캔 금지)
 * - 입력이 **이미 추출된 time 토큰**이면 그 전체 문자열을 그대로 해석
 * - "[...]"로 시작하면 대괄호 내부를 사용
 * - 해석 규칙:
 *   · ABS: 정확히 `YYYY-MM-DDTHH:MM:SS(.sss)?(Z|±HH:MM)` → Date.parse 그대로
 *   · NAIVE(연/타임존 빠짐 또는 타임존만 빠짐):
 *       - "Mon DD HH:MM:SS(.sss)" / "MM-DD HH:MM:SS(.sss)" 등 → **연도 없음**이면 호스트 올해 주입
 *       - "YYYY-MM-DD[ T]HH:MM:SS(.sss)"(오프셋 없음) → 연도는 있음, **UTC 해석**
 *     모두 **UTC 해석**으로 epoch(ms) 계산(호스트 타임존 의존 금지)
 * - 실패 시 undefined
 */
export function parseTs(line: string): number | undefined {
  return measureBlock('TimeParser.parseTs', () => {
    const token = extractHeaderTimeToken(line);
    if (!token) return undefined;

    // 1) ABS (ISO8601 + 오프셋/Z) — 토큰 전체가 정확히 매치되어야 함
    const ABS_RX =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
    if (ABS_RX.test(token)) {
      const t = Date.parse(token);
      return Number.isNaN(t) ? undefined : t;
    }

    // 2) NAIVE with YEAR but no offset: "YYYY-MM-DD[ T]HH:MM:SS(.sss)"
    const YMD_RX =
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;
    const ymd = token.match(YMD_RX);
    if (ymd) {
      const [, y, mo, d, hh, mm, ss, sss] = ymd;
      const ms = toMs3(sss);
      // UTC 해석
      return Date.UTC(
        toInt(y),
        toInt(mo) - 1,
        toInt(d),
        toInt(hh),
        toInt(mm),
        toInt(ss),
        ms,
      );
    }

    // 3) NAIVE without year: "Mon DD HH:MM:SS(.sss)"
    const MON_RX =
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/i;
    const mon = token.match(MON_RX);
    if (mon) {
      const [, monName, dd, hh, mm, ss, sss] = mon;
      const month = monthNameToIndex(monName);
      if (month >= 0) {
        const year = new Date().getFullYear(); // ✅ 연도만 호스트에서 주입
        const ms = toMs3(sss);
        // UTC 해석
        return Date.UTC(year, month, toInt(dd), toInt(hh), toInt(mm), toInt(ss), ms);
      }
    }

    // 4) NAIVE without year: "MM-DD HH:MM:SS(.sss)"
    const MD_RX =
      /^(\d{1,2})-(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;
    const md = token.match(MD_RX);
    if (md) {
      const [, mo, dd, hh, mm, ss, sss] = md;
      const year = new Date().getFullYear(); // ✅ 연도만 호스트에서 주입
      const ms = toMs3(sss);
      // UTC 해석
      return Date.UTC(
        year,
        toInt(mo) - 1,
        toInt(dd),
        toInt(hh),
        toInt(mm),
        toInt(ss),
        ms,
      );
    }

    return undefined;
  });
}

// ── 보조 유틸 ────────────────────────────────────────────────────────────
/** 전체 라인/토큰에서 헤더 타임 토큰을 추출 */
export function extractHeaderTimeToken(line: string): string | null {
  const s = String(line ?? '').trim();
  if (!s) return null;
  if (s[0] === '[') {
    // 선두가 '['면 닫는 ']'까지를 헤더로 보고 내부만 추출
    const r = s.indexOf(']');
    if (r > 0) return s.slice(1, r).trim();
    return null; // 비정상 대괄호는 시간 아님
  }
  // 접두부에서 시간 헤더를 정밀 추출(전체 라인에서도 동작)
  const ABS_PREFIX =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/;
  const YMD_PREFIX =
    /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)/;
  const MON_PREFIX =
    /^((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)/i;
  const MD_PREFIX =
    /^(\d{1,2}-\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)/;
  const m =
    s.match(ABS_PREFIX) ||
    s.match(YMD_PREFIX) ||
    s.match(MON_PREFIX) ||
    s.match(MD_PREFIX);
  if (m) return (m[1] || '').trim();
  // 마지막 폴백: 첫 공백 전까지(ISO 날짜 단일 토큰 등)
  const sp = s.indexOf(' ');
  return (sp >= 0 ? s.slice(0, sp) : s).trim();
}

/** 주어진 time 토큰이 '연도 없는 포맷'인지 판별 */
export function isYearlessTimeToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const s = String(token).trim();
  if (!s) return false;
  const ABS_RX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  const YMD_RX = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;
  const MON_RX = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?$/i;
  const MD_RX  = /^(\d{1,2})-(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;
  if (ABS_RX.test(s) || YMD_RX.test(s)) return false;
  return MON_RX.test(s) || MD_RX.test(s);
}
function monthNameToIndex(m: string): number {
  const names = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const i = names.indexOf(String(m || '').slice(0,3).toLowerCase());
  return i;
}
function toInt(s: string | undefined): number {
  return Math.max(0, parseInt(String(s ?? '0'), 10) || 0);
}
function toMs3(frac: string | undefined): number {
  if (!frac) return 0;
  const ms3 = String(frac).slice(0, 3).padEnd(3, '0');
  return parseInt(ms3, 10) || 0;
}

export function guessLevel(line: string): 'D' | 'I' | 'W' | 'E' {
  return measureBlock('TimeParser.guessLevel', () => {
    if (/\b(error|err|fail|fatal)\b/i.test(line)) return 'E';
    if (/\bwarn(ing)?\b/i.test(line)) return 'W';
    if (/\b(debug|trace)\b/i.test(line)) return 'D';
    return 'I';
  });
}
