// === src/core/logs/time/TimeParser.ts ===

/** 라인에서 타임스탬프(epoch ms)를 추출; 실패 시 undefined */
export function parseTs(line: string): number | undefined {
  // ISO-like 먼저
  const iso = line.match(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/,
  );
  if (iso) {
    const t = Date.parse(iso[0]);
    if (!Number.isNaN(t)) return t;
  }
  // "MM-DD HH:MM:SS.mmm" (연도는 올해 가정)
  const md = line.match(/(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (md) {
    const now = new Date();
    const d = new Date(
      now.getFullYear(),
      parseInt(md[1], 10) - 1,
      parseInt(md[2], 10),
      parseInt(md[3], 10),
      parseInt(md[4], 10),
      parseInt(md[5], 10),
      md[6] ? parseInt(md[6].slice(0, 3).padEnd(3, '0'), 10) : 0,
    );
    return d.getTime();
  }
  return undefined;
}

export function guessLevel(line: string): 'D' | 'I' | 'W' | 'E' {
  if (/\b(error|err|fail|fatal)\b/i.test(line)) return 'E';
  if (/\bwarn(ing)?\b/i.test(line)) return 'W';
  if (/\bdebug|trace\b/i.test(line)) return 'D';
  return 'I';
}
