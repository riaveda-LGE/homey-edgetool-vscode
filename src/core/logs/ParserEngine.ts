import * as fs from 'fs';
import * as path from 'path';
import type {
  ParserConfig,
  ParserFieldRegex,
  ParserPreflight,
  ParserRequirements,
} from '../config/schema.js';
import { parseTs } from './time/TimeParser.js';
import { guessLevel } from './time/TimeParser.js'; // same module에서 export 중이면 병합, 아니면 적절히 import
import type { ParsedPayload } from '@ipc/messages';

export type { ParserConfig };

export type ParsedFields = {
  time?: string;
  process?: string;
  pid?: string;
  message?: string;
};

// ANSI escape 제거(표준 범위)
function stripAnsi(s: string | undefined): string | undefined {
  if (!s) return s;
  return s.replace(/[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]/g, '');
}

// time 토큰 정리: 혹시 남아있을 수도 있는 대괄호 제거 + trim
function normalizeTimeToken(s: string | undefined): string | undefined {
  if (!s) return s;
  const t = s.trim();
  const m = t.match(/^\[(.*)\]$/);
  return m ? m[1] : t;
}

/** 단일 정규식 문자열을 적용해 named capture 를 반환(없으면 undefined) */
function applyCompiledOne(rx: RegExp | undefined, line: string): string | undefined {
  if (!rx) return undefined;
  const m = rx.exec(line);
  if (!m?.groups) return undefined;
  // groups 안에 해당 키가 없을 수 있으므로, 첫 번째 named key를 우선 반환
  // (예: (?<time>...), (?<process>...) 등)
  const keys = Object.keys(m.groups);
  if (!keys.length) return undefined;
  return m.groups[keys[0]];
}

/** 컴파일된 정규식으로 각 필드 개별 추출 */
function extractFieldsByCompiledRule(line: string, regex: {
  time?: RegExp; process?: RegExp; pid?: RegExp; message?: RegExp;
}): ParsedFields {
  const raw = {
    time:    applyCompiledOne(regex.time, line),
    process: applyCompiledOne(regex.process, line),
    pid:     applyCompiledOne(regex.pid, line),
    message: applyCompiledOne(regex.message, line),
  };
  // 정규화: time 대괄호 제거(방어적), message ANSI 스트립
  return {
    time: normalizeTimeToken(raw.time),
    process: raw.process ?? undefined,
    pid: raw.pid ?? undefined,
    message: stripAnsi(raw.message),
  };
}

/* ────────────────────────────────────────────────────────────
 * Custom Parser Compiler / Matcher / Preflight
 * ──────────────────────────────────────────────────────────── */

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 템플릿 files 토큰을 "파일명(basename) 전용" 정규식으로 컴파일
 *  - **정규식**: '^'로 시작하면 그대로(i 플래그)
 *  - **리터럴**: 그 외는 정확히 그 파일명만 매칭하도록 ^…$ 앵커링(i 플래그)
 *  - 매칭 대상은 항상 **basename**.
 */
function fileTokenToRegex(token: string): RegExp | null {
  if (!token || typeof token !== 'string') return null;
  const t = token.trim();
  // 정규식 고정식(시작 앵커 포함)을 우선 인식
  if (t.startsWith('^')) {
    try {
      return new RegExp(t, 'i');
    } catch {
      return null;
    }
  }
  // 글롭 미지원: 리터럴 파일명 그대로 매칭
  return new RegExp(`^${escapeRe(t)}$`, 'i');
}

export type CompiledRule = {
  fileRegexes: RegExp[]; // 파일 "이름(basename)" 매칭
  regex: {
    time?: RegExp;
    process?: RegExp;
    pid?: RegExp;
    message?: RegExp;
  };
};

export type CompiledParser = {
  version: number;
  requirements: Required<ParserRequirements>;
  preflight: Required<ParserPreflight> & { hardSkip: RegExp[] };
  rules: CompiledRule[];
};

export function compileParserConfig(cfg?: ParserConfig): CompiledParser | undefined {
  if (!cfg || !Array.isArray(cfg.parser) || cfg.parser.length === 0) return undefined;
  const reqDefault: Required<ParserRequirements> = {
    fields: { time: false, process: false, pid: false, message: true },
  };
  const pfDefault: Required<ParserPreflight> = {
    sample_lines: 200,
    min_match_ratio: 0.8,
    hard_skip_if_any_line_matches: [],
  };
  const requirements: Required<ParserRequirements> = {
    fields: {
      time: !!cfg.requirements?.fields?.time,
      process: !!cfg.requirements?.fields?.process,
      pid: !!cfg.requirements?.fields?.pid,
      message: cfg.requirements?.fields?.message ?? true,
    },
  };
  const preflight = {
    ...pfDefault,
    ...cfg.preflight,
  };
  const hardSkip = (preflight.hard_skip_if_any_line_matches ?? []).map((p) => {
    try {
      return new RegExp(p, 'i'); // Windows/대소문자 무시
    } catch {
      return new RegExp('a^'); // never
    }
  });

  const rules: CompiledRule[] = [];
  for (const r of cfg.parser) {
    if (!Array.isArray(r.files) || !r.files.length) continue;
    const fileRegexes = r.files
      .map((g) => fileTokenToRegex(String(g).trim()))
      .filter(Boolean) as RegExp[];
    if (!fileRegexes.length) continue;
    const cr: CompiledRule = {
      fileRegexes,
      regex: {
        time: r.regex?.time ? new RegExp(r.regex.time) : undefined,
        process: r.regex?.process ? new RegExp(r.regex.process) : undefined,
        pid: r.regex?.pid ? new RegExp(r.regex.pid) : undefined,
        message: r.regex?.message ? new RegExp(r.regex.message) : undefined,
      },
    };
    rules.push(cr);
  }
  if (!rules.length) return undefined;
  return {
    version: cfg.version ?? 1,
    requirements: requirements || reqDefault,
    preflight: { ...preflight, hardSkip },
    rules,
  };
}

export function matchRuleForPath(relOrAbsPath: string, cp: CompiledParser): CompiledRule | undefined {
  // 경로 → POSIX 슬래시 → basename만 추출하여 파일명만으로 매칭
  const norm = relOrAbsPath.replace(/\\/g, '/');
  const base = norm.includes('/') ? norm.slice(norm.lastIndexOf('/') + 1) : norm;
  for (const r of cp.rules) {
    if (r.fileRegexes.some((rx) => rx.test(base))) return r;
  }
  return undefined;
}

function isLineMatchByRequirements(line: string, rule: CompiledRule, req: Required<ParserRequirements>): boolean {
  const f = extractFieldsByCompiledRule(line, rule.regex);
  const need = req.fields;
  // 필수 지정된 필드가 모두 존재해야 "매치"로 간주
  if (need.time && !f.time) return false;
  if (need.process && !f.process) return false;
  if (need.pid && !f.pid) return false;
  if (need.message && !f.message) return false;
  // 아무 것도 필수 아니면 message 기준으로 최소 보장
  if (!need.time && !need.process && !need.pid && !need.message) return !!f.message;
  return true;
}

async function readSampleLines(filePath: string, maxLines: number): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const out: string[] = [];
    let residual = '';
    const rs = fs.createReadStream(filePath, { encoding: 'utf8' });
    rs.on('data', (chunk: string | Buffer) => {
      const txt = residual + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
      const parts = txt.split(/\r?\n/);
      residual = parts.pop() ?? '';
      for (const p of parts) {
        if (p) out.push(p);
        if (out.length >= maxLines) {
          rs.close();
          break;
        }
      }
    });
    rs.on('end', () => {
      if (residual && out.length < maxLines) out.push(residual);
      resolve(out);
    });
    rs.on('error', (e) => reject(e));
  });
}

export async function shouldUseParserForFile(
  filePath: string,
  relPath: string,
  cp: CompiledParser,
): Promise<boolean> {
  const rule = matchRuleForPath(relPath || filePath, cp);
  if (!rule) return false;
  const pf = cp.preflight;
  // 샘플 라인 로드
  const sample = await readSampleLines(filePath, Math.max(1, pf.sample_lines));
  if (!sample.length) return false;
  // 하드스킵: 하나라도 걸리면 false
  if (pf.hardSkip.length) {
    for (const line of sample) {
      if (pf.hardSkip.some((rx) => rx.test(line))) return false;
    }
  }
  // 매칭 비율 계산
  let matched = 0;
  for (const line of sample) {
    if (isLineMatchByRequirements(line, rule, cp.requirements)) matched++;
  }
  const ratio = matched / sample.length;
  return ratio >= pf.min_match_ratio;
}

export function extractByCompiledRule(line: string, rule: CompiledRule): ParsedFields {
  return extractFieldsByCompiledRule(line, rule.regex);
}

export function lineToEntryWithParser(
  filePath: string,
  line: string,
  cp?: CompiledParser,
  opts?: { fallbackTs?: number; fileRank?: number; revIdx?: number },
): import('@ipc/messages').LogEntry {
  const bn = path.basename(filePath);
  // ⬇️ 파싱 실패 시 '고정' fallback: prevTs(or 0)
  let ts = parseTs(line) ?? (opts?.fallbackTs ?? 0);
  let level: 'D' | 'I' | 'W' | 'E' = guessLevel(line);
  let type: 'system' | 'homey' | 'application' | 'other' = 'system';
  let source = bn;
  let file = bn;
  let path_ = filePath;
  let text = line;
  let parsed: ParsedPayload | undefined;

  if (cp) {
    // warmup/T1 모두 basename 기준 일관 매칭
    const rule = matchRuleForPath(bn, cp);
    if (rule) {
      const fields = extractByCompiledRule(line, rule);
      // time
      if (fields.time) ts = parseTs(fields.time) ?? ts;
      // message
      if (fields.message) text = fields.message;
      // 레벨은 메시지/라인에서 휴리스틱
      level = guessLevel(fields.message ?? line);
      // ⬇️ 파싱 필드 보관(대괄호 제거/ANSI 제거된 최소 정규화 상태)
      parsed = {
        time: fields.time ?? null,
        process: fields.process ?? null,
        pid: fields.pid ?? null,
        message: fields.message ?? null,
      };
    }
  }

  const entry: import('@ipc/messages').LogEntry = {
    id: Date.now(),
    ts,
    level,
    type,
    source,
    file,
    path: path_,
    text,
    parsed,
  };

  // 병합 tie-break 용 메타 (선택 필드)
  (entry as any)._fRank = opts?.fileRank;
  (entry as any)._rev = opts?.revIdx;
  return entry;
}
