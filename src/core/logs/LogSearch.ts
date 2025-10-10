// === src/core/logs/LogSearch.ts ===
import type { LogEntry } from '../../extension/messaging/messageTypes.js';

export type SearchQuery = { q?: string; regex?: boolean; range?: [number, number]; top?: number };

export function search(entries: LogEntry[], q: SearchQuery): LogEntry[] {
  let out = entries;
  if (q.range) out = out.filter((e) => e.ts >= q.range![0] && e.ts <= q.range![1]);
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
