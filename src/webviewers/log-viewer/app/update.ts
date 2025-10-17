// src/webviewers/log-viewer/app/update.ts
import { parseLogLine } from './parse';
import type { ColumnId,LogRow, Model, Msg } from './types';

export function update(model: Model, msg: Msg): Model {
  switch (msg.type) {
    case 'SetTotalRows': {
      const total = Math.max(0, Number(msg.total) || 0);
      return { ...model, totalRows: total };
    }

    case 'ReceiveRows': {
      // 서버(호스트)에서 내려온 창(window)의 행들로 교체
      // id는 증가시키되, 현재 창만 유지(가상 스크롤의 윈도우)
      const rows = msg.rows ?? [];
      // nextId 갱신
      const maxId = Math.max(model.nextId, (rows.at(-1)?.id ?? 0) + 1);
      return {
        ...model,
        rows,
        nextId: maxId,
        windowStart: Math.max(1, Number(msg.startIdx) || 1),
      };
    }

    case 'AppendLog': {
      const p = parseLogLine(msg.line);
      // src는 메시지 타입에 없으므로 안전하게 any로 수용
      const row: LogRow = { id: model.nextId, ...p, src: (msg as any).src };
      const rows = [...model.rows, row];
      const overflow = rows.length - model.bufferSize;
      if (overflow > 0) rows.splice(0, overflow);
      return { ...model, rows, nextId: model.nextId + 1 };
    }

    case 'AppendLogsBatch': {
      const lines = Array.isArray(msg.lines) ? msg.lines : [];
      if (lines.length === 0) return model;

      let nextId = model.nextId;
      const appended: LogRow[] = [];
      for (const line of lines) {
        const p = parseLogLine(line);
        appended.push({ id: nextId++, ...p });
      }
      const rows = [...model.rows, ...appended];
      const overflow = rows.length - model.bufferSize;
      if (overflow > 0) rows.splice(0, overflow);
      return { ...model, rows, nextId };
    }

    case 'ToggleColumn': {
      const showCols = { ...model.showCols, [msg.col]: msg.on };
      return { ...model, showCols };
    }

    case 'OpenHighlight':
      return { ...model, showHighlightEditor: true };

    case 'CloseHighlight':
      return { ...model, showHighlightEditor: false };

    case 'SetHighlights': {
      const rules = msg.rules
        .filter((r) => r.text.trim())
        .slice(0, 5)
        .map((r) => ({ text: r.text.trim(), color: r.color || 'c1' }));
      return { ...model, highlights: rules, showHighlightEditor: false };
    }

    case 'Search': {
      const q = msg.q ?? '';
      if (!q.trim()) {
        return { ...model, searchQuery: '', searchOpen: false, searchHits: [] };
      }
      const regex = new RegExp(escapeRegExp(q), 'i');
      const hits = model.rows.flatMap((r) => {
        const cols: ColumnId[] = ['time', 'proc', 'pid', 'src', 'msg'];
        const list: { rowId: number; col: ColumnId; excerpt: string }[] = [];
        for (const c of cols) {
          const text = String((r as any)[c] ?? '');
          if (regex.test(text)) {
            const excerpt = buildExcerpt(text, q);
            list.push({ rowId: r.id, col: c, excerpt });
          }
        }
        return list;
      });
      return { ...model, searchQuery: q, searchOpen: true, searchHits: hits };
    }

    case 'SearchClose':
      return { ...model, searchOpen: false, searchQuery: '', searchHits: [] };

    case 'OpenMsgModal':
      return { ...model, modalMsg: msg.text };

    case 'CloseMsgModal':
      return { ...model, modalMsg: undefined };

    case 'ToggleBookmark': {
      const rows = model.rows.map((r) =>
        r.id === msg.rowId ? { ...r, bookmarked: !r.bookmarked } : r
      );
      const any = rows.some((r) => r.bookmarked);
      return { ...model, rows, showBookmarks: any || model.showBookmarks };
    }

    case 'ToggleBookmarksPane':
      return { ...model, showBookmarks: !model.showBookmarks };

    case 'JumpToRow':
      return { ...model, selectedRowId: msg.rowId };

    case 'ResizeColumn': {
      const next = { ...model.colW };
      const base = Math.max(60, ((next as any)[msg.col] || 120) + msg.dx);
      (next as any)[msg.col] = base;
      return { ...model, colW: next };
    }

    case 'StartBoxSelect':
      return { ...model, selecting: true, selRect: msg.rect };

    case 'UpdateBoxSelect':
      return model.selecting ? { ...model, selRect: msg.rect } : model;

    case 'EndBoxSelect':
      return { ...model, selecting: false, selRect: undefined };

    case 'MergeProgress': {
      const total =
        typeof msg.total === 'number' ? Math.max(0, msg.total) : model.mergeTotal;
      const baseDone = msg.reset ? 0 : model.mergeDone;
      const done = Math.max(0, baseDone + (msg.inc ?? 0));
      let active = msg.active ?? model.mergeActive;
      if (total > 0 && done >= total) active = false;
      return { ...model, mergeTotal: total, mergeDone: done, mergeActive: active };
    }

    default:
      return model;
  }
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildExcerpt(text: string, q: string) {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, 120);
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + q.length + 30);
  const slice = text.slice(start, end);
  return slice.replace(new RegExp(escapeRegExp(q), 'ig'), (m) => `<<${m}>>`);
}
