import { useLogStore } from '../../react/store';

export function SearchPanel(){
  const open = useLogStore(s=>s.searchOpen);
  const q = useLogStore(s=>s.searchQuery);
  const hits = useLogStore(s=>s.searchHits);
  const rows = useLogStore(s=>s.rows);
  if (!open) return <div className="tw-hidden" />;

  return (
    <>
      <div className="tw-h-[10px] tw-bg-[var(--panel)] tw-border-t tw-border-[var(--border)]" />
      <section className="tw-min-h-[120px] tw-max-h-[40vh] tw-overflow-auto tw-border-t tw-border-[var(--border-strong)] tw-bg-[var(--panel)]">
        {!hits.length && (
          <div className="tw-px-3 tw-py-2">{q ? '검색 결과 없음' : '검색어를 입력하세요'}</div>
        )}
        {hits.map((h, i)=>{
          const r = rows.find(x=>x.id===h.rowId);
          if (!r) return null;
          const raw = `[${r.time}] ${r.proc}[${r.pid}]:  ${r.msg}`;
          const html = escapeHtml(raw).replace(new RegExp(escapeRegExp(q),'ig'), m=>`<mark>${m}</mark>`);
          return (
            <div key={i} className="tw-px-3 tw-py-2 tw-border-b tw-border-[rgba(255,255,255,.06)] tw-cursor-pointer hover:tw-bg-[var(--row-hover)]"
                 onClick={()=>useLogStore.getState().jumpToRow(r.id)}>
              <div dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          );
        })}
      </section>
    </>
  );
}
function escapeHtml(s: string) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escapeRegExp(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
