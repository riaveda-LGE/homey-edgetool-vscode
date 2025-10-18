// === src/core/logs/LogSearch.ts ===
import type { LogEntry } from '@ipc/messages';

export type SearchQuery = { q?: string; regex?: boolean; range?: [number, number]; top?: number };

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
    if (q.top) out = out.slice(0, q.top);
    return out;
  }
}

// 편의 함수
export function search(entries: LogEntry[], q: SearchQuery): LogEntry[] {
  const searcher = new LogSearch();
  return searcher.search(entries, q);
}
