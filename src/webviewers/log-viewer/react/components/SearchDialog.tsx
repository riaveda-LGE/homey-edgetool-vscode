import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function SearchDialog({
  open,
  initialQuery,
  onSearch,
  onCancel,
}: {
  open: boolean;
  initialQuery?: string;
  onSearch: (q: string) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState(initialQuery ?? '');
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (open) setQ(initialQuery ?? '');
  }, [open, initialQuery]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onSearch(q);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, q, onSearch, onCancel]);
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483647,
        background: 'rgba(0,0,0,.40)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 480,
          background: 'var(--panel)',
          color: 'var(--fg)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          boxShadow: '0 10px 30px rgba(0,0,0,.35)',
          overflow: 'hidden',
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', fontSize: 14 }}
        >
          검색
        </div>
        <div style={{ padding: '12px' }}>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder="검색어"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: 'var(--bg)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '8px 10px',
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button
              onClick={() => onCancel()}
              style={{
                padding: '6px 12px',
                border: '1px solid var(--border)',
                background: 'transparent',
                color: 'inherit',
                borderRadius: 8,
                cursor: 'pointer',
              }}
            >
              취소
            </button>
            <button
              onClick={() => onSearch(q)}
              style={{
                padding: '6px 12px',
                border: 'none',
                background: 'var(--accent)',
                color: 'var(--accent-fg)',
                borderRadius: 8,
                cursor: 'pointer',
              }}
            >
              검색
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
