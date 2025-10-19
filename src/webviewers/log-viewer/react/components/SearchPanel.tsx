import { useLogStore } from '../../react/store';
import { vscode } from '../ipc';

export function SearchPanel(){
  const open = useLogStore(s=>s.searchOpen);
  const q = useLogStore(s=>s.searchQuery);
  const hits = useLogStore(s=>s.searchHits);
  if (!open) return <div className="tw-hidden" />;

  return (
    <>
      {/* 상단 헤더: 결과 개수 & 닫기(X) */}
      <div className="tw-flex tw-items-center tw-justify-between tw-bg-[var(--panel)] tw-border-t tw-border-[var(--border)] tw-px-3 tw-py-1">
        <div className="tw-text-xs tw-opacity-80">
          {`찾은 결과 ${hits.length}개`}{q ? ` — "${q}"` : ''}
        </div>
        <button
          title="검색 결과 닫기"
          className="tw-text-xs tw-rounded tw-border tw-border-[var(--border)] tw-px-2 tw-py-0.5 hover:tw-bg-[var(--row-hover)]"
          onClick={()=>{
            vscode?.postMessage({ v:1, type:'search.clear', payload:{} });
            useLogStore.getState().closeSearch();
          }}
        >
          ×
        </button>
      </div>
      <section className="tw-min-h-[120px] tw-max-h-[40vh] tw-overflow-auto tw-border-t tw-border-[var(--border-strong)] tw-bg-[var(--panel)]">
        {!hits.length && (
          <div className="tw-px-3 tw-py-2">검색 결과 없음</div>
        )}
        {hits.map((h, i)=>{
          // 서버에서 내려온 스니펫(text)을 하이라이트
          const snippet = String(h?.text ?? '');
          const html = q
            ? escapeHtml(snippet).replace(new RegExp(escapeRegExp(q),'ig'), m=>`<mark>${m}</mark>`)
            : escapeHtml(snippet);
          const idx = Number((h as any)?.idx ?? 0);
          return (
            <div
              key={`${idx}-${i}`}
              className="tw-px-3 tw-py-2 tw-border-b tw-border-[rgba(255,255,255,.06)] tw-cursor-pointer hover:tw-bg-[var(--row-hover)]"
              onClick={()=>{ if (idx>0) useLogStore.getState().jumpToIdx(idx); }}
            >
              <div className="tw-text-sm" dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          );
        })}
      </section>
    </>
  );
}
function escapeHtml(s: string) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escapeRegExp(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
