import { Dialog, Transition } from '@headlessui/react';
import { useEffect, useState } from 'react';
import { useLogStore } from '../store';
import type { Filter } from '../types';

export function FilterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const storeFilter = useLogStore(s => s.filter);
  const applyFilter = useLogStore(s => s.applyFilter);
  const resetFilters = useLogStore(s => s.resetFilters);

  const [local, setLocal] = useState(storeFilter);
  useEffect(() => {
    if (open) setLocal(storeFilter);
  }, [open, storeFilter.pid, storeFilter.src, storeFilter.proc, storeFilter.msg]);

  const onApply = () => { applyFilter(normalize(local)); onClose(); };
  const onCancel = () => onClose();

  const field = (k: keyof Filter, label: string, ph?: string) => (
    <label className="tw-grid tw-gap-1">
      <span className="tw-text-xs tw-opacity-70">{label}</span>
      <input
        className="tw-text-sm tw-px-2 tw-py-1 tw-rounded tw-border tw-border-[var(--border)] tw-bg-[var(--bg)]"
        placeholder={ph}
        value={(local[k] ?? '') as string}
        onChange={e => setLocal({ ...local, [k]: e.currentTarget.value })}
      />
    </label>
  );

  return (
    <Transition show={open} appear>
      {/* Dialog 자체에는 className을 주지 않고 래퍼 div에 부여 */}
      <Dialog open={open} onClose={onClose}>
        <div className="tw-relative tw-z-50">
        <Transition.Child
          enter="tw-ease-out tw-duration-100"
          enterFrom="tw-opacity-0"
          enterTo="tw-opacity-100"
          leave="tw-ease-in tw-duration-100"
          leaveFrom="tw-opacity-100"
          leaveTo="tw-opacity-0"
        >
          <div className="tw-fixed tw-inset-0 tw-bg-black/40" />
        </Transition.Child>

        <div className="tw-fixed tw-inset-0 tw-overflow-y-auto">
          <div className="tw-flex tw-min-h-full tw-items-center tw-justify-center tw-p-4">
            <Transition.Child
              enter="tw-ease-out tw-duration-150"
              enterFrom="tw-scale-[0.98] tw-opacity-0"
              enterTo="tw-scale-100 tw-opacity-100"
              leave="tw-ease-in tw-duration-100"
              leaveFrom="tw-scale-100 tw-opacity-100"
              leaveTo="tw-scale-[0.98] tw-opacity-0"
            >
              <Dialog.Panel className="tw-w-[520px] tw-rounded-2xl tw-border tw-border-[var(--border)] tw-bg-[var(--panel)] tw-shadow-xl tw-p-4">
                <Dialog.Title className="tw-text-base tw-mb-3">필터 설정</Dialog.Title>
                <div className="tw-grid tw-grid-cols-2 tw-gap-3">
                  {field('pid', 'PID', 'pid')}
                  {field('src', '파일', '파일명/소스')}
                  {field('proc', '프로세스', '프로세스명')}
                  {field('msg', '메시지', '메시지')}
                </div>

                <div className="tw-flex tw-justify-between tw-items-center tw-mt-4">
                  <button
                    className="tw-text-sm tw-px-2 tw-py-1 tw-rounded tw-border tw-border-[var(--border)]"
                    onClick={() => { resetFilters(); onClose(); }}
                  >
                    초기화
                  </button>
                  <div className="tw-flex tw-gap-2">
                    <button
                      className="tw-text-sm tw-px-2 tw-py-1 tw-rounded tw-border tw-border-[var(--border)]"
                      onClick={onCancel}
                    >
                      취소
                    </button>
                    <button
                      className="tw-text-sm tw-px-3 tw-py-1 tw-rounded tw-bg-[var(--accent)] tw-text-[var(--accent-fg)] hover:tw-bg-[var(--accent-hover)]"
                      onClick={onApply}
                    >
                      적용
                    </button>
                  </div>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
        </div>
      </Dialog>
    </Transition>
  );
}

function normalize(f: Filter): Filter {
  const t = (s?: string) => (s ?? '').trim();
  return { pid: t(f.pid), src: t(f.src), proc: t(f.proc), msg: t(f.msg) };
}
