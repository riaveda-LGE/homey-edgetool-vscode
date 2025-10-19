import { Toolbar } from './Toolbar';
import { Grid } from './Grid';
import { Bookmarks } from './Bookmarks';
import { SearchPanel } from './SearchPanel';
import { useLogStore } from '../../react/store';

export function App(){
  const showBookmarks = useLogStore(s=>s.showBookmarks);
  return (
    <div className="tw-h-full tw-grid tw-min-h-0" style={{ gridTemplateRows: '44px minmax(0,1fr) auto' }}>
      <div className="tw-flex tw-items-center tw-gap-2 tw-px-2 tw-border-b tw-border-[var(--border-strong)] tw-bg-[var(--panel)]">
        <Toolbar />
      </div>

      <div className={`tw-grid tw-min-h-0 ${showBookmarks ? 'tw-grid-cols-[1fr_6px_260px]' : 'tw-grid-cols-1'}`}>
        {/* Grid 내부에 헤더를 포함시켜, Grid 스크롤만 움직이도록 함 */}
        <div className="tw-min-h-0 tw-h-full">
          <Grid />
        </div>
        {showBookmarks && <div className="tw-bg-[var(--panel)] tw-border-x tw-border-[var(--border)]" />}
        {showBookmarks && <Bookmarks />}
      </div>

      <SearchPanel />
    </div>
  );
}
