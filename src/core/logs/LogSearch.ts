// === src/core/logs/LogSearch.ts ===
import type { LogEntry } from '@ipc/messages';

import { measure } from '../logging/perf.js';

export type SearchQuery = {
  q?: string;
  regex?: boolean;
  range?: [number, number];
  top?: number;
  /** 서버측 다중 필드 필터(부분일치) */
  pid?: string;
  file?: string; // source
  process?: string;
  message?: string; // text
};

export interface ILogSearch {
  search(entries: LogEntry[], query: SearchQuery): LogEntry[];
}

export class LogSearch implements ILogSearch {
  @measure()
  search(entries: LogEntry[], q: SearchQuery): LogEntry[] {
    let out = entries;
    const range = q.range;
    if (range && range.length >= 2) out = out.filter((e) => e.ts >= range[0] && e.ts <= range[1]);
    if (q.q) {
      if (q.regex) {
        const r = new RegExp(q.q, 'i');
        out = out.filter((e) => r.test(primaryText(e)));
      } else {
        const s = q.q.toLowerCase();
        out = out.filter((e) => primaryText(e).includes(s));
      }
    }
    // ── 다중 필드 매칭 (부분일치) ───────────────────────────────────────────
    const wantPid = norm(q.pid);
    const wantFile = norm(q.file);
    const wantProc = norm(q.process);
    const wantMsg = norm(q.message);
    if (wantPid || wantFile || wantProc || wantMsg) {
      out = out.filter((e) => {
        const f = extractFields(e); // ← parsed 우선, 없으면 최소 파싱 폴백
        const pidOk = wantPid ? f.pid.includes(wantPid) : true;
        // 파일/경로/소스 중 하나라도 포함되면 통과
        const fileOk = wantFile
          ? [f.file, f.path, f.source]
              .map((v) => String(v ?? '').toLowerCase())
              .some((s) => s.includes(wantFile))
          : true;
        const prOk = wantProc ? f.proc.includes(wantProc) : true;
        const msgOk = wantMsg ? f.msg.includes(wantMsg) : true;
        return pidOk && fileOk && prOk && msgOk;
      });
    }
    if (q.top) out = out.slice(0, q.top);
    return out;
  }
}

// 편의 함수
export function search(entries: LogEntry[], q: SearchQuery): LogEntry[] {
  const searcher = new LogSearch();
  return searcher.search(entries, q);
}

// ── 라인 파서(UI와 동일한 규칙을 서버에서도 사용) ──────────────────────────
function parseLine(line: string) {
  const timeMatch = line.match(/^\[([^\]]+)\]\s+(.*)$/);
  let rest = line;
  if (timeMatch) {
    rest = timeMatch[2];
  }
  const procMatch = rest.match(/^([^\s:]+)\[([^\]]+)\]:\s*(.*)$/);
  let proc = '',
    pid = '',
    msg = rest;
  if (procMatch) {
    proc = procMatch[1];
    pid = procMatch[2];
    msg = procMatch[3] ?? '';
  }
  return { proc, pid, msg };
}
function norm(s?: string) {
  return s && s.trim() ? s.trim().toLowerCase() : '';
}

// ── parsed 우선 활용 유틸 ────────────────────────────────────────────────
function primaryText(e: LogEntry): string {
  // 커스텀 파서가 있으면 message를 우선, 없으면 원문 텍스트
  const msg = ((e as any)?.parsed?.message ?? e.text ?? '').toString();
  return msg.toLowerCase();
}

function extractFields(e: LogEntry): {
  proc: string;
  pid: string;
  msg: string;
  file: string;
  path: string;
  source: string;
} {
  const any = e as any;
  const p = any?.parsed;
  if (p && (p.process || p.pid || p.message || p.time)) {
    return {
      proc: String(p.process ?? '').toLowerCase(),
      pid: String(p.pid ?? '').toLowerCase(),
      msg: String(p.message ?? e.text ?? '').toLowerCase(),
      file: String(any.file ?? '').toLowerCase(),
      path: String(any.path ?? '').toLowerCase(),
      source: String(e.source ?? '').toLowerCase(),
    };
  }
  // 폴백: 기존 헤더 패턴만 읽는 최소 파싱
  const fallback = parseLine(e.text || '');
  return {
    proc: String(fallback.proc ?? '').toLowerCase(),
    pid: String(fallback.pid ?? '').toLowerCase(),
    msg: String(fallback.msg ?? '').toLowerCase(),
    file: String(any.file ?? '').toLowerCase(),
    path: String(any.path ?? '').toLowerCase(),
    source: String(e.source ?? '').toLowerCase(),
  };
}
