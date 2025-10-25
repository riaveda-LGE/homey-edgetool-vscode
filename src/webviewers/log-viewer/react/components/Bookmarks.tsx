import { useLogStore } from '../../react/store';
import { BookmarkSquare } from './BookmarkSquare';
import { createUiLog } from '../../../shared/utils';
import { vscode } from '../ipc';

export function Bookmarks() {
  const bookmarks = useLogStore((s) => s.bookmarks);
  const rows = useLogStore((s) => s.rows);
  const selectedId = useLogStore((s) => s.selectedRowId);
  const selectedIdx = rows.find((r) => r.id === selectedId)?.idx;
  const list = Object.values(bookmarks).sort((a, b) => a.idx - b.idx);
  const ui = createUiLog(vscode, 'log-viewer.bookmarks');
  ui.debug?.('[debug] Bookmarks: render');
  return (
    <aside className="tw-w-[260px] tw-bg-[var(--panel)] tw-border-l tw-border-[var(--border-strong)] tw-flex tw-flex-col tw-min-h-0">
      <div className="tw-font-semibold tw-px-3 tw-py-2 tw-border-b tw-border-[var(--border)]">
        북마크
      </div>
      <div className="tw-flex-1 tw-min-h-0 tw-overflow-y-auto tw-overflow-x-hidden tw-p-2 tw-space-y-1">
        {list.map((r) => {
          const row = rows.find((row) => row.idx === r.idx);
          const rowId = row?.id;
          return (
            <div
              key={r.idx}
              className={`tw-px-2 tw-py-1 tw-rounded tw-cursor-pointer hover:tw-bg-[var(--row-hover)]
                         ${selectedIdx === r.idx ? 'tw-bg-[color-mix(in_oklab,var(--row-selected)_22%,transparent_78%)]' : ''}`}
              onClick={() => {
                ui.debug?.('[debug] Bookmarks: onClick jumpToRow');
                const st = useLogStore.getState();
                // 버퍼 안에 이미 보이는 경우 즉시 하이라이트
                if (rowId) st.jumpToRow(rowId, r.idx);
                // 전역 인덱스를 보존한 점프(버퍼 밖이어도 스크롤/페이지 요청)
                st.jumpToIdx(r.idx);
              }}
            >
              {/* 왼쪽 정렬된 사각형 별 버튼 + 내용 */}
              <div className="tw-grid tw-grid-cols-[28px,1fr] tw-gap-2 tw-items-center">
                {/* 공통 별 사각형 버튼(패널에서도 동일 스타일) */}
                <BookmarkSquare
                  checked
                  variant="panel"
                  title="북마크 해제"
                  onClick={(e) => {
                    ui.debug?.('[debug] BookmarkSquare: onClick toggleBookmarkByIdx');
                    e.stopPropagation();
                    useLogStore.getState().toggleBookmarkByIdx(r.idx);
                  }}
                />
                <div className="tw-min-w-0">
                  <div className="tw-text-xs tw-opacity-80">{r.time}</div>
                  <div className="tw-text-sm tw-truncate">{r.msg}</div>
                </div>
              </div>
            </div>
          );
        })}
        {!list.length && <div className="tw-text-xs tw-opacity-70">북마크가 없습니다.</div>}
      </div>
    </aside>
  );
}
