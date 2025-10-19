import { useLogStore } from '../../react/store';

export function Bookmarks(){
  const rows = useLogStore(s=>s.rows);
  const list = rows.filter(r=>r.bookmarked);
  return (
    <aside className="tw-w-[260px] tw-bg-[var(--panel)] tw-border-l tw-border-[var(--border-strong)] tw-flex tw-flex-col">
      <div className="tw-font-semibold tw-px-3 tw-py-2 tw-border-b tw-border-[var(--border)]">Bookmarks</div>
      <div className="tw-flex-1 tw-overflow-auto tw-p-2 tw-space-y-1">
        {list.map(r=>(
          <div key={r.id} className="tw-px-2 tw-py-1 tw-rounded tw-cursor-pointer hover:tw-bg-[var(--row-hover)]"
               onClick={()=>useLogStore.getState().jumpToRow(r.id)}>
            <div className="tw-text-xs tw-opacity-80">{r.time}</div>
            <div className="tw-text-sm tw-truncate">{r.msg}</div>
          </div>
        ))}
        {!list.length && <div className="tw-text-xs tw-opacity-70">북마크가 없습니다.</div>}
      </div>
    </aside>
  );
}
