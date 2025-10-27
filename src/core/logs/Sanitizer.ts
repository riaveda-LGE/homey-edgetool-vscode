// === src/core/logs/Sanitizer.ts ===
// 로그 텍스트의 '안전한 정규화'를 한 군데에서 관리한다.
// 기본값은 기존 동작과 호환되도록 '과도한 변형'을 피한다.

export type SanitizeOptions = {
  /** 파일/청크의 '첫 글자' 위치에 있는 UTF-8 BOM(U+FEFF) 제거 */
  stripBOMAtStart: boolean;
  /** 줄 끝 CR 제거(Windows CRLF 대응). 기존 코드와 동일하게 per-line로 처리 */
  stripTrailingCR: boolean;
  /** ANSI 이스케이프 제거(기본: false — message 필드에서만 제거 유지) */
  stripAnsi: boolean;
  /** 제어문자 제거(탭 제외). 기본 false — 보수적으로 유지 */
  dropControlExceptTab: boolean;
  /** NBSP(· U+00A0) → 보통 스페이스 치환. 기본 false */
  normalizeNbsp: boolean;
  /** U+FEFF가 라인 중간에 섞여 온 경우 제거(파일 BOM 이외의 FEFF) */
  dropIntralineBOM: boolean;
  /** 유니코드 정규화(NFC). 기본 false */
  unicodeNFC: boolean;
};

export const DEFAULT_SANITIZE: SanitizeOptions = {
  stripBOMAtStart: true,
  stripTrailingCR: true,
  stripAnsi: false, // ← 기존과 동일: message에서만 제거
  dropControlExceptTab: false,
  normalizeNbsp: false,
  dropIntralineBOM: true, // 모바일 로그서 간헐 유입되는 FEFF 방지
  unicodeNFC: false,
};

// UTF-8 BOM 또는 U+FEFF
const BOM_RE = /^\uFEFF/;

// ANSI escape (표준 범위: 기존 ParserEngine과 동등 이상)
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]/g;

// 탭을 제외한 C0 제어 + DEL
// eslint-disable-next-line no-control-regex
const CTRL_EXCEPT_TAB_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// 라인 내부의 U+FEFF (BOM이 아닌 zero-width no-break space 역할)
const INTRALINE_BOM_RE = /\uFEFF/g;

/** 파일/청크의 "시작 위치" BOM만 제거 */
export function stripBomStart(s: string): string {
  return s.replace(BOM_RE, '');
}

/** ANSI 이스케이프 제거 */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** 탭 제외 제어문자 제거 */
export function dropControlExceptTab(s: string): string {
  return s.replace(CTRL_EXCEPT_TAB_RE, '');
}

/** NBSP(U+00A0) → 스페이스 */
export function normalizeNbsp(s: string): string {
  return s.replace(/\u00A0/g, ' ');
}

/** 라인 내부 FEFF 제거 */
export function dropIntralineBOM(s: string): string {
  return s.replace(INTRALINE_BOM_RE, '');
}

/** 단일 라인 단위 정리(분리 후 적용) */
export function sanitizeLine(line: string, opt: Partial<SanitizeOptions> = {}): string {
  const o = { ...DEFAULT_SANITIZE, ...opt };
  let s = line;

  if (o.stripTrailingCR) s = s.replace(/\r$/, '');
  if (o.dropIntralineBOM) s = dropIntralineBOM(s);
  if (o.dropControlExceptTab) s = dropControlExceptTab(s);
  if (o.normalizeNbsp) s = normalizeNbsp(s);
  if (o.stripAnsi) s = stripAnsi(s);
  if (o.unicodeNFC && (s as any).normalize) s = s.normalize('NFC');

  return s;
}

/**
 * 스트림에서 읽은 '청크'를 라인 split 전에 가볍게 정리할 때 사용.
 * - 첫 청크에는 stripBOMAtStart 적용
 * - CRLF 처리는 라인 단위에서 하므로 여기선 건드리지 않음
 */
export function sanitizeChunkBeforeSplit(
  chunk: string,
  isFirstChunk: boolean,
  opt: Partial<SanitizeOptions> = {},
): string {
  const o = { ...DEFAULT_SANITIZE, ...opt };
  let s = chunk;
  if (isFirstChunk && o.stripBOMAtStart) s = stripBomStart(s);
  // 라인 내부 FEFF/제어문자/NBSP는 조기 제거해도 안전 (선택)
  if (o.dropIntralineBOM) s = dropIntralineBOM(s);
  if (o.dropControlExceptTab) s = dropControlExceptTab(s);
  if (o.normalizeNbsp) s = normalizeNbsp(s);
  if (o.unicodeNFC && (s as any).normalize) s = s.normalize('NFC');
  // ANSI 제거는 기본적으로 message 단계에서만 — 여기서는 하지 않음
  return s;
}
