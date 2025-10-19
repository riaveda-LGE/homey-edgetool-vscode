import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLogStore } from '../store';
import type { Filter } from '../types';
import { createUiLog } from '../../../shared/utils';
import { vscode } from '../ipc';

export function FilterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const storeFilter = useLogStore(s => s.filter);
  const applyFilter = useLogStore(s => s.applyFilter);
  const resetFilters = useLogStore(s => s.resetFilters);
  const ui = useMemo(()=>createUiLog(vscode,'log-viewer.filter'),[]);

  const [local, setLocal] = useState(storeFilter);
  useEffect(() => {
    if (open) {
      ui.info('filterDialog.open');
      setLocal(storeFilter);
    } else {
      ui.info('filterDialog.close');
    }
  }, [open, storeFilter.pid, storeFilter.src, storeFilter.proc, storeFilter.msg]);

  // 오픈 시 실제 DOM의 z-index/크기를 로그로 확인
  useEffect(() => {
    if (!open) return;
    // 살짝 지연 후 측정(Transition 적용 직후 레이아웃 안정화)
    const t = setTimeout(() => {
      const overlay = document.querySelector('[data-testid="filter-overlay"]') as HTMLElement | null;
      const panel = document.querySelector('[data-testid="filter-panel"]') as HTMLElement | null;
      if (overlay) {
        const zi = getComputedStyle(overlay).zIndex;
        const r = overlay.getBoundingClientRect();
        ui.info(`filterDialog.dom.overlay z=${zi} rect=(${Math.round(r.left)},${Math.round(r.top)}) ${Math.round(r.width)}x${Math.round(r.height)}`);
      } else {
        ui.warn('filterDialog.dom.overlay not found');
      }
      if (panel) {
        const zi = getComputedStyle(panel).zIndex;
        const r = panel.getBoundingClientRect();
        ui.info(`filterDialog.dom.panel z=${zi} rect=(${Math.round(r.left)},${Math.round(r.top)}) ${Math.round(r.width)}x${Math.round(r.height)}`);
      } else {
        ui.warn('filterDialog.dom.panel not found');
      }
    }, 30);
    return () => clearTimeout(t);
  }, [open, ui]);

  // Esc로 닫기(외부 클릭은 닫지 않음)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  const onApply = () => {
    // 전체 필드를 정규화(빈 칩/중복 제거)한 뒤 적용
    const cleaned = normalizeAll(local);
    ui.info(`filterDialog.apply ${JSON.stringify(cleaned)}`);
    setLocal(cleaned);
    applyFilter(normalize(cleaned));
    onClose();
  };
  const onCancel = () => { ui.info('filterDialog.cancel'); onClose(); };

  // ── OR 그룹 UI: "wlan host, deauth" → [["wlan","host"],["deauth"]] ─────────────
  const parseGroups = (s?: string): string[][] => {
    const src = String(s ?? '');
    if (!src.trim()) return [];
    return src
      .split(',')
      .map(g => g.trim())
      .filter(Boolean)
      .map(g => g.split(/\s+/g).map(t => t.trim()).filter(Boolean));
  };
  const serializeGroups = (groups: string[][]) =>
    groups
      .map(g => {
        const uniq: string[] = [];
        for (const t of g) if (t && !uniq.includes(t)) uniq.push(t);
        return uniq.join(' ');
      })
      .filter(Boolean)
      .join(', ');

  // 모든 필드 정규화(빈 그룹/빈 칩/중복 제거)
  const normalizeAll = (f: Filter): Filter => ({
    pid : serializeGroups(parseGroups(f?.pid)),
    src : serializeGroups(parseGroups(f?.src)),
    proc: serializeGroups(parseGroups(f?.proc)),
    msg : serializeGroups(parseGroups(f?.msg)),
  });

  const setGroupsFor = (k: keyof Filter, groups: string[][]) => {
    setLocal({ ...local, [k]: serializeGroups(groups) });
  };
  const removeTokenAt = (k: keyof Filter, gIdx: number, token: string) => {
    const groups = parseGroups((local as any)[k]);
    if (!groups[gIdx]) return;
    groups[gIdx] = groups[gIdx].filter(t => t !== token);
    if (groups[gIdx].length === 0) groups.splice(gIdx, 1);
    setGroupsFor(k, groups);
  };
  const removeGroup = (k: keyof Filter, gIdx: number) => {
    const groups = parseGroups((local as any)[k]);
    groups.splice(gIdx, 1);
    setGroupsFor(k, groups);
  };
  const clearField = (k: keyof Filter) => setGroupsFor(k, []);
  const addOrGroup = (k: keyof Filter) => {
    // 단순히 ", "을 추가(빈 그룹은 적용 시 정리)
    const cur = String((local as any)[k] ?? '');
    const next = cur.replace(/\s+$/, '');
    setLocal({ ...local, [k]: next ? next + ', ' : ', ' });
  };

  // 단일 필드 행(라벨 / 입력 / 칩 / 필드 초기화)
  const FieldRow = (k: keyof Filter, label: string, ph?: string) => {
    const value = (local[k] ?? '') as string;
    const groups = parseGroups(value);
    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '72px minmax(0, 240px) minmax(0, 1fr) auto',
          gap: 10,
          alignItems: 'center',
        }}
      >
        {/* 라벨 */}
        <div style={{ fontSize: 12, opacity: 0.75 }}>{label}</div>

        {/* 입력 */}
        <input
          className="tw-text-sm tw-px-2 tw-py-1 tw-rounded tw-border tw-border-[var(--border)] tw-bg-[var(--bg)]"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '6px 8px',
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--bg)',
            color: 'var(--fg)',
            fontSize: 13,
          }}
          placeholder={ph}
          value={value}
          onChange={(e) => setLocal({ ...local, [k]: e.currentTarget.value })}
          onBlur={(e) => {
            // 포커스 아웃 시 해당 필드만 정규화(빈 그룹/중복 정리)
            const v = serializeGroups(parseGroups(e.currentTarget.value));
            if (v !== (local[k] ?? '')) setLocal({ ...local, [k]: v });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !(e as any).nativeEvent?.isComposing) {
              e.preventDefault();
              // 현재 입력값을 포함해 전 필드 정규화 후 즉시 적용
              const cur = { ...local, [k]: (e.currentTarget as HTMLInputElement).value };
              const cleaned = normalizeAll(cur);
              ui.info(`filterDialog.apply.enter ${JSON.stringify(cleaned)}`);
              setLocal(cleaned);
              applyFilter(normalize(cleaned));
              onClose();
            }
          }}
        />

        {/* 필터된 항목(그룹 칩) */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', minHeight: 28 }}>
          {groups.length === 0 ? (
            <span style={{ fontSize: 12, opacity: 0.5 }}>없음</span>
          ) : (
            groups.map((g, gi) => (
              <div
                key={`g${gi}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  color: 'inherit',
                  padding: '4px 6px',
                  borderRadius: 12,
                }}
              >
                {g.length === 0 ? (
                  <span style={{ fontSize: 12, opacity: 0.6 }}>빈 그룹</span>
                ) : (
                  g.map((t, ti) => (
                    <button
                      key={`${gi}-${ti}-${t}`}
                      title={`${label} 항목 제거: ${t}`}
                      onClick={() => removeTokenAt(k, gi, t)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        border: '1px solid var(--border)',
                        background: 'transparent',
                        color: 'inherit',
                        fontSize: 12,
                        padding: '2px 8px',
                        borderRadius: 999,
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t}
                      </span>
                      <span aria-hidden>×</span>
                    </button>
                  ))
                )}
                <button
                  title="이 OR 그룹 제거"
                  onClick={() => removeGroup(k, gi)}
                  aria-label="OR 그룹 제거"
                  style={{
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    fontSize: 12,
                    opacity: 0.8,
                    padding: '0 4px',
                  }}
                >
                  ×
                </button>
                {gi < groups.length - 1 && <span style={{ fontSize: 12, opacity: 0.6, padding: '0 2px' }}>OR</span>}
              </div>
            ))
          )}
          <button
            onClick={() => addOrGroup(k)}
            className="tw-text-xs tw-px-2 tw-py-[3px] tw-rounded tw-border tw-border-[var(--border)]"
            style={{ fontSize: 12, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 8, background: 'transparent', cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            + OR 그룹
          </button>
        </div>

        {/* 필드 초기화 */}
        <button
          onClick={() => clearField(k)}
          title={`${label} 초기화`}
          className="tw-text-sm tw-px-2 tw-py-1 tw-rounded tw-border tw-border-[var(--border)]"
          style={{
            fontSize: 12,
            padding: '6px 10px',
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          초기화
        </button>
      </div>
    );
  };

  if (!open) return null;

  // Headless UI 제거: document.body로 직접 포탈 + 인라인 스타일(고정/전면)
  return createPortal(
    <>
      {/* Backdrop (전면, 전체 뷰포트) */}
      <div
        data-testid="filter-overlay"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 2147483646,
          background: 'rgba(0,0,0,0.40)',
        }}
        onMouseDown={(e)=>{ e.stopPropagation(); }}
        onClick={(e)=>{ e.stopPropagation(); }}
      />

      {/* Container (센터링) */}
      <div
        data-testid="filter-container"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 2147483646,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1rem',
          overflowY: 'auto',
        }}
        onMouseDown={(e)=>{ e.stopPropagation(); }}
        onClick={(e)=>{ e.stopPropagation(); }}
      >
        <div
          data-testid="filter-panel"
          /* Tailwind 미작동 시에도 정확히 보이도록 인라인 스타일로 강제 */
          style={{
            width: 640,
            maxWidth: 'min(96vw, 860px)',
            background: 'var(--panel)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 16,
            boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
            padding: 16,
          }}
          className="tw-w-[520px] tw-rounded-2xl tw-border tw-border-[var(--border)] tw-bg-[var(--panel)] tw-shadow-xl tw-p-4"
        >
          <div className="tw-text-base tw-mb-3" style={{ fontSize:14, marginBottom:12, fontWeight:600 }}>필터 설정</div>
          {/* 세로(Vertical) 필드 영역 */}
          <div style={{ display:'grid', gap:12 }}>
            {FieldRow('pid',  'PID',     '예: 1234 5678, 9012')}
            {FieldRow('src',  '파일',    '예: kernel.log, matter')}
            {FieldRow('proc', '프로세스','예: wlan0 hostapd, cpcd')}
            {FieldRow('msg',  '메시지',  '예: wlan host, deauth')}
          </div>

          <div className="tw-flex tw-justify-between tw-items-center tw-mt-4" style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:16 }}>
            <button
              className="tw-text-sm tw-px-2 tw-py-1 tw-rounded tw-border tw-border-[var(--border)]"
              style={{ fontSize:12, padding:'6px 10px', border:'1px solid var(--border)', borderRadius:8, background:'transparent', color:'inherit', cursor:'pointer' }}
              onClick={() => { ui.info('filterDialog.reset'); resetFilters(); onClose(); }}
            >
              전체 초기화
            </button>
            <div className="tw-flex tw-gap-2" style={{ display:'flex', gap:8 }}>
              {/* ⬅ 요청: 적용이 왼쪽, 취소가 오른쪽 */}
              <button
                className="tw-text-sm tw-px-3 tw-py-1 tw-rounded tw-bg-[var(--accent)] tw-text-[var(--accent-fg)] hover:tw-bg-[var(--accent-hover)]"
                style={{ fontSize:12, padding:'6px 12px', borderRadius:8, background:'var(--accent)', color:'var(--accent-fg)', border:'none', cursor:'pointer' }}
                onClick={onApply}
              >
                적용
              </button>
              <button
                className="tw-text-sm tw-px-2 tw-py-1 tw-rounded tw-border tw-border-[var(--border)]"
                style={{ fontSize:12, padding:'6px 12px', border:'1px solid var(--border)', borderRadius:8, background:'transparent', color:'inherit', cursor:'pointer' }}
                onClick={onCancel}
              >
                취소
              </button>
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}

function normalize(f: Filter): Filter {
  const t = (s?: string) => (s ?? '').trim();
  return { pid: t(f.pid), src: t(f.src), proc: t(f.proc), msg: t(f.msg) };
}
