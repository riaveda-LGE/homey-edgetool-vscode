import { useMemo } from 'react';

import { createUiLog } from '../../../shared/utils';
import { useLogStore } from '../../react/store';
import { vscode } from '../ipc';

export function SearchPanel() {
  const open = useLogStore((s) => s.searchOpen);
  const q = useLogStore((s) => s.searchQuery);
  const hits = useLogStore((s) => s.searchHits);
  const totalRows = useLogStore((s) => s.totalRows);
  // 인덱스 열 너비(총행수 자릿수 기반): 최소 48px, 최대 120px
  const idxWidthPx = useMemo(() => {
    const digits = Math.max(2, String(Math.max(1, totalRows || 0)).length);
    return Math.min(120, Math.max(48, 14 + digits * 8));
  }, [totalRows]);
  // search panel 전용 ui logger
  const ui = createUiLog(vscode, 'log-viewer.search-panel');
  ui.debug?.('[debug] SearchPanel: render');
  if (!open) return <div className="tw-hidden" />;

  return (
    <>
      {/* 상단 헤더: 결과 개수 & 닫기(X) */}
      <div
        className="tw-flex tw-items-center tw-justify-between tw-bg-[var(--panel)] tw-border-t tw-border-[var(--border)] tw-px-3 tw-py-1"
        style={{ ['--col-idx-w' as any]: `${idxWidthPx}px` }}
      >
        <div className="tw-text-xs tw-opacity-80">
          {`찾은 결과 ${hits.length}개`}
          {q ? ` — "${q}"` : ''}
        </div>
        <button
          title="검색 결과 닫기"
          className="tw-text-xs tw-rounded tw-border tw-border-[var(--border)] tw-px-2 tw-py-0.5 hover:tw-bg-[var(--row-hover)]"
          onClick={() => {
            vscode?.postMessage({ v: 1, type: 'search.clear', payload: {} });
            useLogStore.getState().closeSearch();
          }}
        >
          ×
        </button>
      </div>
      <section
        className="tw-min-h-[120px] tw-max-h-[40vh] tw-overflow-auto tw-border-t tw-border-[var(--border-strong)] tw-bg-[var(--panel)]"
        style={{ ['--col-idx-w' as any]: `${idxWidthPx}px` }}
      >
        {!hits.length && <div className="tw-px-3 tw-py-2">검색 결과 없음</div>}
        {hits.map((h, i) => {
          // 서버에서 내려온 스니펫(text)을 하이라이트
          const snippet = String(h?.text ?? '');
          const html = q
            ? escapeHtml(snippet).replace(
                new RegExp(escapeRegExp(q), 'ig'),
                (m) => `<mark>${m}</mark>`,
              )
            : escapeHtml(snippet);
          const idx = Number((h as any)?.idx ?? 0);
          return (
            <div
              key={`${idx}-${i}`}
              className="tw-px-3 tw-py-2 tw-border-b tw-border-[rgba(255,255,255,.06)] tw-cursor-pointer hover:tw-bg-[var(--row-hover)]"
              onClick={() => {
                if (idx > 0) useLogStore.getState().jumpToIdx(idx);
                // 선택 강조는 receiveRows에서 idx 매칭으로 보장됨
              }}
            >
              <div className="tw-grid tw-grid-cols-[var(--col-idx-w)_1fr] tw-gap-2 tw-items-start">
                {/* 전역 인덱스 표시(고정폭, 모노스페이스, 우측 정렬) */}
                <div className="tw-font-mono tw-tabular-nums tw-text-right tw-text-xs tw-opacity-80">
                  {idx > 0 ? idx : ''}
                </div>
                <div className="tw-text-sm" dangerouslySetInnerHTML={{ __html: html }} />
              </div>
            </div>
          );
        })}
      </section>
    </>
  );
}
function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
