import { useMemo, useState } from 'react';

import { useLogStore } from '../../react/store';
import type { HighlightColor, HighlightRule } from '../types';

const COLORS: { id: HighlightColor; hex: string }[] = [
  { id: 'c1', hex: '#ffe066' },
  { id: 'c2', hex: '#ffd43b' },
  { id: 'c3', hex: '#ffa94d' },
  { id: 'c4', hex: '#ff8787' },
  { id: 'c5', hex: '#ff6b6b' },
  { id: 'c6', hex: '#f06595' },
  { id: 'c7', hex: '#b197fc' },
  { id: 'c8', hex: '#74c0fc' },
  { id: 'c9', hex: '#63e6be' },
  { id: 'c10', hex: '#a9e34b' },
  { id: 'c11', hex: '#ffd8a8' },
  { id: 'c12', hex: '#d0bfff' },
];

export function HighlightPopover() {
  const current = useLogStore((s) => s.highlights);
  const setHighlights = useLogStore((s) => s.setHighlights);
  const [rules, setRules] = useState<HighlightRule[]>(() => {
    const base = Array.from({ length: 5 }, (_, i) => ({ text: '', color: 'c1' as HighlightColor }));
    current.forEach((r, i) => {
      base[i] = { text: r.text, color: (r.color ?? 'c1') as HighlightColor };
    });
    return base;
  });

  const apply = () => setHighlights(rules);
  const setText = (i: number, v: string) =>
    setRules((r) => r.map((x, idx) => (idx === i ? { ...x, text: v } : x)));
  const pick = (i: number, c: HighlightColor) =>
    setRules((r) => r.map((x, idx) => (idx === i ? { ...x, color: c } : x)));

  return (
    <div className="tw-space-y-2" style={{ color: 'var(--fg, #e6e6e6)' }}>
      <div className="tw-text-xs tw-opacity-80">하이라이트 단어 (최대 5개)</div>
      {rules.map((r, i) => (
        <div key={i} className="tw-grid tw-grid-cols-[auto_1fr] tw-gap-2 tw-items-center">
          <div className="tw-grid tw-grid-cols-12 tw-gap-1">
            {COLORS.map((c) => (
              <button
                key={c.id}
                title={c.id}
                className={`tw-w-4 tw-h-4 tw-rounded tw-border ${r.color === c.id ? 'tw-outline' : 'tw-outline-none'}`}
                style={{ background: c.hex, borderColor: 'var(--border, rgba(255,255,255,.15))' }}
                onClick={() => pick(i, c.id)}
              />
            ))}
          </div>
          <input
            className="tw-text-sm tw-px-2 tw-py-1 tw-rounded tw-border tw-border-[var(--border)] tw-bg-[var(--bg)] tw-text-[var(--fg)] placeholder:tw-text-[var(--muted)] focus:tw-outline-none focus:tw-ring-1 focus:tw-ring-[var(--accent)]"
            style={{ color: 'var(--fg, #e6e6e6)' }}
            placeholder={`단어 ${i + 1}`}
            value={r.text}
            onChange={(e) => setText(i, e.currentTarget.value)}
          />
        </div>
      ))}
      <div className="tw-flex tw-justify-end tw-gap-2">
        <button
          className="tw-text-sm tw-px-2 tw-py-1 tw-rounded tw-border tw-border-[var(--border)] tw-text-[var(--fg)]"
          onClick={() => setRules(Array.from({ length: 5 }, () => ({ text: '', color: 'c1' })))}
        >
          초기화
        </button>
        <button
          className="tw-text-sm tw-px-2 tw-py-1 tw-rounded-xl2 tw-bg-[var(--accent)] tw-text-[var(--accent-fg)] hover:tw-bg-[var(--accent-hover)]"
          onClick={apply}
        >
          적용
        </button>
      </div>
    </div>
  );
}
