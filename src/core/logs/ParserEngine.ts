import type { ParserFieldRegex } from '../config/schema.js';

export type ParsedFields = {
  time?: string;
  process?: string;
  pid?: string;
  message?: string;
};

/** 단일 정규식 문자열을 적용해 named capture 를 반환(없으면 undefined) */
function applyOne(rxStr: string | undefined, line: string): string | undefined {
  if (!rxStr) return undefined;
  const rx = new RegExp(rxStr);
  const m = rx.exec(line);
  if (!m?.groups) return undefined;
  // groups 안에 해당 키가 없을 수 있으므로, 첫 번째 named key를 우선 반환
  // (예: (?<time>...), (?<process>...) 등)
  const keys = Object.keys(m.groups);
  if (!keys.length) return undefined;
  return m.groups[keys[0]];
}

/** 새 스키마의 regex 세트로 각 필드 개별 추출 */
export function extractFieldsByRule(line: string, regex: ParserFieldRegex): ParsedFields {
  return {
    time: applyOne(regex.time, line),
    process: applyOne(regex.process, line),
    pid: applyOne(regex.pid, line),
    message: applyOne(regex.message, line),
  };
}
