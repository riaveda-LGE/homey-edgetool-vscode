import { useLogStore } from '../../react/store';
import { BookmarkSquare } from './BookmarkSquare';
import { createUiLog } from '../../../shared/utils';
import { vscode } from '../ipc';

export function Bookmarks() {
  const rows = useLogStore((s) => s.rows);
  const selectedId = useLogStore((s) => s.selectedRowId);
  const list = rows.filter((r) => r.bookmarked);
  const ui = createUiLog(vscode, 'log-viewer.bookmarks');
  ui.debug?.('[debug] Bookmarks: render');
  return (
    <aside className="tw-w-[260px] tw-bg-[var(--panel)] tw-border-l tw-border-[var(--border-strong)] tw-flex tw-flex-col tw-min-h-0">
      <div className="tw-font-semibold tw-px-3 tw-py-2 tw-border-b tw-border-[var(--border)]">
        북마크
      </div>
      <div className="tw-flex-1 tw-min-h-0 tw-overflow-y-auto tw-overflow-x-hidden tw-p-2 tw-space-y-1">
        {list.map((r) => (
          <div
            key={r.id}
            className={`tw-px-2 tw-py-1 tw-rounded tw-cursor-pointer hover:tw-bg-[var(--row-hover)]
                       ${selectedId === r.id ? 'tw-bg-[color-mix(in_oklab,var(--row-selected)_22%,transparent_78%)]' : ''}`}
            onClick={() => {
              ui.debug?.('[debug] Bookmarks: onClick jumpToRow');
              const st = useLogStore.getState();
              // 버퍼 안에 이미 보이는 경우 즉시 하이라이트
              st.jumpToRow(r.id, r.idx);
              // 전역 인덱스를 보존한 점프(버퍼 밖이어도 스크롤/페이지 요청)
              const idx = typeof r.idx === 'number' ? r.idx : 0;
              if (idx > 0) st.jumpToIdx(idx);
            }}
          >
            {/* 왼쪽 정렬된 사각형 별 버튼 + 내용 */}
            <div className="tw-grid tw-grid-cols-[28px,1fr] tw-gap-2 tw-items-center">
              {/* 공통 별 사각형 버튼(패널에서도 동일 스타일) */}
              <BookmarkSquare
                checked
                title="북마크 해제"
                onClick={(e) => {
                  ui.debug?.('[debug] BookmarkSquare: onClick toggleBookmark');
                  e.stopPropagation();
                  useLogStore.getState().toggleBookmark(r.id);
                }}
              />
              <div className="tw-min-w-0">
                <div className="tw-text-xs tw-opacity-80">{r.time}</div>
                <div className="tw-text-sm tw-truncate">{r.msg}</div>
              </div>
            </div>
          </div>
        ))}
        {!list.length && <div className="tw-text-xs tw-opacity-70">북마크가 없습니다.</div>}
      </div>
    </aside>
  );
}
