import { useLogStore } from '../../react/store';
import { vscode } from '../ipc';
import { useState } from 'react';
import { Popover, Transition } from '@headlessui/react';
import { HighlightPopover } from './HighlightPopover';
import { FilterDialog } from './FilterDialog';

export function Toolbar(){
  const show = useLogStore(s=>s.showCols);
  const setCol = useLogStore(s=>s.toggleColumn);
  const setSearch = useLogStore(s=>s.setSearch);
  const closeSearch = useLogStore(s=>s.closeSearch);
  const toggleBookmarksPane = useLogStore(s=>s.toggleBookmarksPane);
  const progress = useLogStore(s=>({active:s.mergeActive, done:s.mergeDone, total:s.mergeTotal}));
  const [filterOpen, setFilterOpen] = useState(false);

  const savePref = (k:string, v:boolean) => vscode?.postMessage({ v:1, type:'logviewer.saveUserPrefs', payload:{ prefs: { [k]: v } } });

  return (
    <>
      <Popover className="tw-relative">
        <Popover.Button className="tw-px-2 tw-py-1 tw-rounded-2xl tw-bg-[var(--accent)] tw-text-[var(--accent-fg)] hover:tw-bg-[var(--accent-hover)]">
          하이라이트
        </Popover.Button>
        <Transition
          enter="tw-transition tw-duration-100 tw-ease-out"
          enterFrom="tw-opacity-0 tw-translate-y-1"
          enterTo="tw-opacity-100 tw-translate-y-0"
          leave="tw-transition tw-duration-75 tw-ease-in"
          leaveFrom="tw-opacity-100 tw-translate-y-0"
          leaveTo="tw-opacity-0 tw-translate-y-1">
          <Popover.Panel className="tw-absolute tw-z-10 tw-mt-2 tw-w-[380px] tw-rounded-2xl tw-border tw-border-[var(--border)] tw-bg-[var(--panel)] tw-p-3 tw-shadow-xl">
            <HighlightPopover />
          </Popover.Panel>
        </Transition>
      </Popover>

      <span className="tw-w-px tw-h-6 tw-bg-[var(--border)] tw-mx-2" />

      {(['time','proc','pid','src','msg'] as const).map(id=>(
        <label key={id} className="tw-inline-flex tw-items-center tw-gap-1">
          <input
            type="checkbox"
            checked={show[id]}
            onChange={e=>{ setCol(id, e.currentTarget.checked); savePref(prefKey(id), e.currentTarget.checked); }}
          />
          <span className="tw-text-sm">{labelOf(id)}</span>
        </label>
      ))}

      <div className="tw-flex tw-items-center tw-gap-2 tw-ml-3 tw-flex-1">
        {progress.total>0 && (
          <div className="tw-flex tw-items-center tw-gap-2 tw-min-w-[200px] tw-max-w-[440px]">
            <div className="tw-relative tw-flex-1 tw-h-2 tw-rounded tw-bg-[color-mix(in_oklab,var(--border)_70%,transparent_30%)] tw-shadow-[inset_0_0_0_1px_rgba(0,0,0,.08)]">
              <div className="tw-absolute tw-left-0 tw-top-0 tw-bottom-0 tw-rounded tw-bg-[var(--accent)]" style={{ width: `${Math.min(100, Math.floor((Math.min(progress.done, progress.total)/progress.total)*100))}%` }} />
            </div>
            <span className="tw-text-xs tw-tabular-nums tw-opacity-80">({Math.min(progress.done, progress.total)}/{progress.total})</span>
          </div>
        )}
      </div>

      <input className="tw-text-sm tw-px-2 tw-py-1 tw-rounded tw-border tw-border-[var(--border)] tw-bg-[var(--bg)]"
        placeholder="검색어"
        onChange={e=>setSearch(e.currentTarget.value)} />
      <button className="tw-text-sm tw-px-2 tw-py-1 tw-rounded tw-border tw-border-[var(--border)]" onClick={()=>closeSearch()}>검색 닫기</button>
      <button
        className="tw-text-sm tw-px-2 tw-py-1 tw-rounded tw-border tw-border-[var(--border)]"
        onClick={()=>setFilterOpen(true)}
      >
        필터링
      </button>
      <button className="tw-text-sm tw-px-2 tw-py-1 tw-rounded tw-border tw-border-[var(--border)]" onClick={()=>{ toggleBookmarksPane(); vscode?.postMessage({ v:1, type:'logviewer.saveUserPrefs', payload:{ prefs: { bookmarksOpen: !useLogStore.getState().showBookmarks } } }); }}>
        북마크 보기
      </button>
      <FilterDialog open={filterOpen} onClose={()=>setFilterOpen(false)} />
    </>
  );
}

function labelOf(id: 'time'|'proc'|'pid'|'src'|'msg'){
  return id==='time'?'시간':id==='proc'?'프로세스':id==='pid'?'PID':id==='src'?'파일':'메시지';
}
function prefKey(id: 'time'|'proc'|'pid'|'src'|'msg'){
  return id==='time'?'showTime':id==='proc'?'showProc':id==='pid'?'showPid':id==='src'?'showSrc':'showMsg';
}
