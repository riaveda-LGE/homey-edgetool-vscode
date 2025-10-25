import { Popover, Transition } from '@headlessui/react';
import { useMemo, useState } from 'react';

import { createUiLog } from '../../../shared/utils';
import { useLogStore } from '../../react/store';
import { vscode } from '../ipc';
import { FilterDialog } from './FilterDialog';
import { HighlightPopover } from './HighlightPopover';
import { SearchDialog } from './SearchDialog';

export function Toolbar() {
  const show = useLogStore((s) => s.showCols);
  const setCol = useLogStore((s) => s.toggleColumn);
  const setSearch = useLogStore((s) => s.setSearch);
  const openSearchPanel = useLogStore((s) => s.openSearchPanel);
  const toggleBookmarksPane = useLogStore((s) => s.toggleBookmarksPane);
  const progress = useLogStore((s) => ({
    active: s.mergeActive,
    done: s.mergeDone,
    total: s.mergeTotal,
  }));
  const filter = useLogStore((s) => s.filter);
  const follow = useLogStore((s) => s.follow);
  const newSincePause = useLogStore((s) => s.newSincePause);
  const setFollow = useLogStore((s) => s.setFollow);
  const clearNewSincePause = useLogStore((s) => s.clearNewSincePause);
  const [filterOpen, setFilterOpen] = useState(false);
  const [searchDlgOpen, setSearchDlgOpen] = useState(false);
  const ui = useMemo(() => createUiLog(vscode, 'log-viewer.toolbar'), []);

  const savePref = (k: string, v: boolean) => {
    ui.debug?.('[debug] Toolbar: savePref');
    vscode?.postMessage({ v: 1, type: 'logviewer.saveUserPrefs', payload: { prefs: { [k]: v } } });
  };

  // ── 활성 필드 개수 표시(버튼의 필터(x) 용) ───────────────────────────
  const activeCount = (() => {
    ui.debug?.('[debug] Toolbar: activeCount');
    const t = (v?: string) => String(v ?? '').trim();
    return ['pid', 'src', 'proc', 'msg'].reduce((n, k) => n + (t((filter as any)[k]) ? 1 : 0), 0);
  })();

  const labelOf = (id: 'time' | 'proc' | 'pid' | 'src' | 'msg') => {
    return id === 'time'
      ? '시간'
      : id === 'proc'
        ? '프로세스'
        : id === 'pid'
          ? 'PID'
          : id === 'src'
            ? '파일'
            : '메시지';
  };
  const prefKey = (id: 'time' | 'proc' | 'pid' | 'src' | 'msg') => {
    return id === 'time'
      ? 'showTime'
      : id === 'proc'
        ? 'showProc'
        : id === 'pid'
          ? 'showPid'
          : id === 'src'
            ? 'showSrc'
            : 'showMsg';
  };

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
          leaveTo="tw-opacity-0 tw-translate-y-1"
        >
          <Popover.Panel className="tw-absolute tw-z-10 tw-mt-2 tw-w-[380px] tw-rounded-2xl tw-border tw-border-[var(--border)] tw-bg-[var(--panel)] tw-p-3 tw-shadow-xl">
            <HighlightPopover />
          </Popover.Panel>
        </Transition>
      </Popover>

      <span className="tw-w-px tw-h-6 tw-bg-[var(--border)] tw-mx-2" />

      {(['time', 'proc', 'pid', 'src', 'msg'] as const).map((id) => (
        <label key={id} className="tw-inline-flex tw-items-center tw-gap-1">
          <input
            type="checkbox"
            checked={show[id]}
            onChange={(e) => {
              setCol(id, e.currentTarget.checked);
              savePref(prefKey(id), e.currentTarget.checked);
            }}
          />
          <span className="tw-text-sm">{labelOf(id)}</span>
        </label>
      ))}

      <div className="tw-flex tw-items-center tw-gap-2 tw-ml-3 tw-flex-1">
        {progress.total > 0 && (
          <div className="tw-flex tw-items-center tw-gap-2 tw-min-w-[200px] tw-max-w-[440px]">
            <div className="tw-relative tw-flex-1 tw-h-2 tw-rounded tw-bg-[color-mix(in_oklab,var(--border)_70%,transparent_30%)] tw-shadow-[inset_0_0_0_1px_rgba(0,0,0,.08)]">
              <div
                className="tw-absolute tw-left-0 tw-top-0 tw-bottom-0 tw-rounded tw-bg-[var(--accent)]"
                style={{
                  width: `${Math.min(100, Math.floor((Math.min(progress.done, progress.total) / progress.total) * 100))}%`,
                }}
              />
            </div>
            <span className="tw-text-xs tw-tabular-nums tw-opacity-80">
              ({Math.min(progress.done, progress.total)}/{progress.total})
            </span>
          </div>
        )}
      </div>

      {/* 검색: 인라인 입력 제거 → 버튼 + 팝업 */}
      <button
        className="tw-text-sm tw-px-2 tw-py-1 tw-rounded tw-border tw-border-[var(--border)]"
        onClick={() => {
          setSearchDlgOpen(true);
        }}
        data-testid="btn-search"
      >
        검색
      </button>
      <SearchDialog
        open={searchDlgOpen}
        initialQuery={useLogStore((s) => s.searchQuery)}
        onCancel={() => setSearchDlgOpen(false)}
        onSearch={(q) => {
          const query = (q ?? '').trim();
          ui.info(`search.button q="${query}"`);
          setSearch(query); // 쿼리만 저장
          openSearchPanel(); // 패널 오픈을 명시적으로
          if (query) vscode?.postMessage({ v: 1, type: 'search.query', payload: { q: query } });
          setSearchDlgOpen(false);
        }}
      />

      <button
        className={[
          'tw-text-sm tw-px-2 tw-py-1 tw-rounded tw-border tw-border-[var(--border)] tw-relative',
          activeCount > 0
            ? 'tw-bg-[var(--accent)] tw-text-[var(--accent-fg)] hover:tw-bg-[var(--accent-hover)]'
            : '',
        ].join(' ')}
        onClick={() => {
          ui.info(`toolbar.filter.click activeCount=${activeCount}`);
          setFilterOpen(true);
        }}
        title={activeCount > 0 ? `활성 필드 ${activeCount}개` : '필터'}
        data-testid="btn-filter"
      >
        {`필터${activeCount > 0 ? `(${activeCount})` : ''}`}
      </button>
      <button
        className={[
          'tw-text-sm tw-px-2 tw-py-1 tw-rounded tw-border tw-border-[var(--border)] tw-relative',
          follow
            ? 'tw-bg-[var(--accent)] tw-text-[var(--accent-fg)] hover:tw-bg-[var(--accent-hover)]'
            : '',
        ].join(' ')}
        onClick={() => {
          const next = !follow;
          setFollow(next);
          if (next) clearNewSincePause(); // FOLLOW 모드로 돌아올 때 배지 클리어
          ui.info(`toolbar.follow.click follow=${next}`);
        }}
        title={follow ? '실시간 로그 따라가기 중지' : '실시간 로그 따라가기 재개'}
      >
        {follow ? '팔로우 중' : '맨 아래로'}
        {newSincePause > 0 && !follow && (
          <span className="tw-absolute -tw-top-1 -tw-right-1 tw-bg-red-500 tw-text-white tw-text-xs tw-rounded-full tw-px-1 tw-min-w-[18px] tw-h-4 tw-flex tw-items-center tw-justify-center">
            {newSincePause > 99 ? '99+' : newSincePause}
          </span>
        )}
      </button>
      <button
        className="tw-text-sm tw-px-2 tw-py-1 tw-rounded tw-border tw-border-[var(--border)]"
        onClick={() => {
          toggleBookmarksPane();
          vscode?.postMessage({
            v: 1,
            type: 'logviewer.saveUserPrefs',
            payload: { prefs: { bookmarksOpen: !useLogStore.getState().showBookmarks } },
          });
        }}
      >
        북마크
      </button>
      <FilterDialog
        open={filterOpen}
        onClose={() => {
          ui.info('toolbar.filter.close');
          setFilterOpen(false);
        }}
      />
    </>
  );
}
