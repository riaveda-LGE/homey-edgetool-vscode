// === src/core/logs/LogSearch.ts ===
import type { LogEntry, LogFilter } from '@ipc/messages';

export type SearchQuery = {
  q?: string; regex?: boolean; range?: [number, number]; top?: number;
  /** 서버측 다중 필드 필터(부분일치) */
  pid?: string;
  file?: string;      // source
  process?: string;
  message?: string;   // text
};

export interface ILogSearch {
  search(entries: LogEntry[], query: SearchQuery): LogEntry[];
}

export class LogSearch implements ILogSearch {
  search(entries: LogEntry[], q: SearchQuery): LogEntry[] {
    let out = entries;
    const range = q.range;
    if (range && range.length >= 2) out = out.filter((e) => e.ts >= range[0] && e.ts <= range[1]);
    if (q.q) {
      if (q.regex) {
        const r = new RegExp(q.q, 'i');
        out = out.filter((e) => r.test(e.text));
      } else {
        const s = q.q.toLowerCase();
        out = out.filter((e) => e.text.toLowerCase().includes(s));
      }
    }
    // ── 다중 필드 매칭 (부분일치) ───────────────────────────────────────────
    const wantPid = norm(q.pid);
    const wantFile = norm(q.file);
    const wantProc = norm(q.process);
    const wantMsg = norm(q.message);
    if (wantPid || wantFile || wantProc || wantMsg) {
      out = out.filter(e => {
        const parsed = parseLine(e.text || '');
        const pidOk  = wantPid  ? String(parsed.pid).toLowerCase().includes(wantPid) : true;
        const fileOk = wantFile ? String(e.source || '').toLowerCase().includes(wantFile) : true;
        const prOk   = wantProc ? String(parsed.proc).toLowerCase().includes(wantProc) : true;
        const msgOk  = wantMsg  ? String(parsed.msg).toLowerCase().includes(wantMsg) : true;
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
function parseLine(line: string){
  const timeMatch = line.match(/^\[([^\]]+)\]\s+(.*)$/);
  let rest = line;
  if (timeMatch){ rest = timeMatch[2]; }
  const procMatch = rest.match(/^([^\s:]+)\[(\d+)\]:\s*(.*)$/);
  let proc='', pid='', msg=rest;
  if (procMatch){ proc = procMatch[1]; pid = procMatch[2]; msg = procMatch[3] ?? ''; }
  return { proc, pid, msg };
}
function norm(s?: string){ return s && s.trim() ? s.trim().toLowerCase() : ''; }
