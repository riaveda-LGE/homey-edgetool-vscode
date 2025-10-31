import type { H2W } from '@ipc/messages';

import { createUiLog, createUiMeasure, wrapAllUiMethods } from '../../shared/utils.js';
import { ExplorerService } from '../services/ExplorerService.js';
import { HostBridge } from '../services/HostBridge.js';
import { PersistService } from '../services/PersistService.js';
import type { TreeNode } from '../types/model.js';
import { AppView } from '../views/AppView.js';
import { createInitialState, reducer } from './reducer.js';
import { createStore } from './store.js';

(function () {
  const vscode = acquireVsCodeApi();
  const host = new HostBridge(vscode);
  const uiLog = createUiLog(vscode, 'ui.edgePanel');
  // 저비용 샘플링: 1ms 미만은 무시, 필요시 sampleEvery로 더 억제 가능
  const measureUi = createUiMeasure(vscode, { minMs: 1, sampleEvery: 1, source: 'edgePanel' });
  const m = <T>(name: string, fn: () => T): T => measureUi(name, fn);

  const rootEl = document.getElementById('root') as HTMLElement | null;
  const controlsEl = document.getElementById('controls') as HTMLElement | null;
  const sectionsEl = document.getElementById('sections') as HTMLElement | null;
  const splitter = document.getElementById('splitter') as HTMLElement | null;
  const contentEl = document.getElementById('content') as HTMLElement | null;
  if (!rootEl || !controlsEl || !sectionsEl || !splitter || !contentEl) {
    uiLog.error('[edge-panel] missing required elements');
    return;
  }

  const store = createStore(createInitialState(), reducer);
  // 계측: store.dispatch
  const _dispatch = store.dispatch;
  (store as any).dispatch = ((a: any) =>
    m('Store.dispatch', () => _dispatch(a))) as typeof store.dispatch;

  // 계측: services/bridge
  const explorer = wrapAllUiMethods(new ExplorerService(host), measureUi, 'ExplorerService');
  const persist = wrapAllUiMethods(new PersistService(host), measureUi, 'PersistService');
  const hostProxy = wrapAllUiMethods(host, measureUi, 'HostBridge');

  // Node registry helpers
  const nodesByPath = () => store.getState().nodesByPath;
  const getNodeByPath = (p: string) => nodesByPath().get(p);
  const registerNode = (n: TreeNode) => nodesByPath().set(n.path, n);

  const appView = new AppView(
    rootEl,
    controlsEl,
    sectionsEl,
    // ▶ 웹뷰 내부 전역 계측자 전달 (올바른 파라미터 순서로 이동)
    measureUi,
    // controls click
    (id) =>
      m('UI.button.click', () => hostProxy.post({ v: 1, type: 'button.click', payload: { id } })),
    // request buttons
    () =>
      m('UI.requestButtons', () =>
        hostProxy.post({ v: 1, type: 'ui.requestButtons', payload: {} }),
      ),
    // list
    (path) => m('Explorer.list', () => explorer.list(path)),
    // get/register
    (p) => getNodeByPath(p)!,
    (n) => registerNode(n),
    // open
    (n) => m('Explorer.open', () => explorer.open(n.path)),

    // ▼ 폴더 토글 처리: 루트는 토글 금지, 확장시 로딩만 요청 (DOM은 TreeView가 updateExpanded로 처리)
    (n) => {
      if (n.kind !== 'folder') return;
      if (n.path === '') {
        // 루트는 항상 펼침 고정
        n.expanded = true;
        if (!n.loaded) m('Explorer.list(root-once)', () => explorer.list('')); // 초기 한 번은 목록 로드
        return;
      }
      // 이 시점에서 TreeView가 n.expanded 값을 토글해 둠
      if (n.expanded && !n.loaded) {
        m('Explorer.list(expand)', () => explorer.list(n.path));
      }
    },

    (n, multi) =>
      m('Explorer.select', () =>
        store.dispatch({ type: 'EXPLORER_SELECT', node: n, multi } as any),
      ),
    (full, isFile) =>
      m(isFile ? 'Explorer.createFile' : 'Explorer.createFolder', () =>
        isFile ? explorer.createFile(full) : explorer.createFolder(full),
      ),
    (nodes) =>
      m('Explorer.delete(batch)', () =>
        nodes.forEach((node) => explorer.delete(node.path, node.kind === 'folder', true)),
      ),
    (p) => m('PanelState.save', () => persist.save(p)),
    // Debug Log Panel 콜백
    () =>
      m('DebugLog.loadOlder', () =>
        hostProxy.post({ v: 1, type: 'debuglog.loadOlder', payload: {} }),
      ),
    () => m('DebugLog.clear', () => hostProxy.post({ v: 1, type: 'debuglog.clear', payload: {} })),
    () => m('DebugLog.copy', () => hostProxy.post({ v: 1, type: 'debuglog.copy', payload: {} })),
  );

  // ── Git 데코레이션(파일별) ────────────────────────────────────────────
  type GitLiteItem = { path: string; code: 'A' | 'M' | 'D' | 'R' | 'C' | '??' };
  type GitLite = {
    staged: GitLiteItem[];
    modified: GitLiteItem[];
    untracked: GitLiteItem[];
    conflicts?: number;
    clean: boolean;
    repo?: boolean;
    branch?: string | null;
  };

  // ✅ 경로별 상태 + 스테이징 여부를 함께 저장
  type GitEntry = { code: 'A' | 'M' | 'D' | 'R' | 'C' | 'U'; staged: boolean };
  const gitStatusMap = new Map<string, GitEntry>();

  // 우선순위: D > R > C > A > M > U (코드 색상 선택용)
  const codeOrder = new Map([
    ['D', 6],
    ['R', 5],
    ['C', 4],
    ['A', 3],
    ['M', 2],
    ['U', 1],
  ]);

  const normalizeKey = (p: string) => {
    // 'old → new' 형태라면 new 쪽만 사용
    const arrow = p.indexOf('→');
    return (arrow >= 0 ? p.slice(arrow + 1) : p).trim();
  };

  const applyGitDecorations = () => {
    const nodes = nodesByPath();
    nodes.forEach((node) => {
      if (!node.el) return;

      const entry = gitStatusMap.get(node.path) || null;
      const label = node.el.querySelector('.tn-label') as HTMLElement | null;
      const right = node.el.querySelector('.tn-right') as HTMLElement | null;
      if (!label || !right) return;

      // 라벨 색상 클래스 리셋
      label.classList.remove('git-A', 'git-M', 'git-D', 'git-R', 'git-C', 'git-U');

      // 배지 영역 초기화
      right.innerHTML = '';
      if (!entry) return;

      // 라벨 색상은 코드 기준으로만
      label.classList.add(`git-${entry.code}`);

      // 1) 스테이징 배지 (파란색 S)
      if (entry.staged) {
        const s = document.createElement('span');
        s.className = 'git-badge git-stage';
        s.textContent = 'S';
        right.appendChild(s);
      }

      // 2) 주 상태 배지 (U/M/D/A/R/C)
      const badge = document.createElement('span');
      badge.className = `git-badge git-${entry.code}`;
      badge.textContent = entry.code; // 'U'는 이미 맵핑된 상태
      right.appendChild(badge);
    });
  };

  const updateGitStatusMap = (s: GitLite) => {
    gitStatusMap.clear();

    const put = (rawPath: string, codeRaw: GitLiteItem['code'], staged: boolean) => {
      const key = normalizeKey(rawPath);
      const code = (codeRaw === '??' ? 'U' : (codeRaw as any)) as GitEntry['code'];
      const prev = gitStatusMap.get(key);

      if (!prev) {
        gitStatusMap.set(key, { code, staged });
        return;
      }
      // 코드 우선순위 갱신
      const prevRank = codeOrder.get(prev.code)!;
      const nextRank = codeOrder.get(code)!;
      if (nextRank > prevRank) prev.code = code;
      // 스테이징 여부는 OR
      prev.staged = prev.staged || staged;
    };

    // 인덱스(스테이징) → staged=true
    s.staged.forEach((x) => put(x.path, x.code, true));
    // 워킹트리 변경 → staged=false
    s.modified.forEach((x) => put(x.path, x.code, false));
    // 언트래킹 → U, staged=false
    s.untracked.forEach((x) => put(x.path, '??', false));

    applyGitDecorations();
  };

  // =========================
  // 포커스 이탈 시 선택 해제 (웹뷰 쪽 즉시 처리)
  // =========================
  window.addEventListener('blur', () => {
    m('UI.blur.clearSelection', () => {
      appView.clearExplorerSelection();
      store.dispatch({ type: 'EXPLORER_CLEAR_SELECTION' } as any);
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      m('UI.visibilitychange.clearSelection', () => {
        appView.clearExplorerSelection();
        store.dispatch({ type: 'EXPLORER_CLEAR_SELECTION' } as any);
      });
    }
  });

  // ✅ 바깥 클릭/ESC에서 Explorer 선택 해제(+상태도 초기화)
  document.addEventListener('mousedown', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && t.closest('#explorer')) return; // Explorer 내부는 무시
    m('Explorer.clearSelection(mousedown-outside)', () => {
      appView.clearExplorerSelection();
      store.dispatch({ type: 'EXPLORER_CLEAR_SELECTION' } as any);
    });
  });
  document.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') {
      m('Explorer.clearSelection(Escape)', () => {
        appView.clearExplorerSelection();
        store.dispatch({ type: 'EXPLORER_CLEAR_SELECTION' } as any);
      });
    }
  });

  // UI subscriptions
  store.subscribe((s) => {
    m('AppView.applyLayout', () => appView.applyLayout(s));
  });

  // Host messages
  host.listen((msg: H2W) => {
    const setButtonsDisabled = (ids: string[], disabled: boolean) => {
      ids.forEach((id) => {
        const el = document.querySelector(
          `button[data-btn-id="${id}"]`,
        ) as HTMLButtonElement | null;
        if (el) el.disabled = disabled;
      });
    };
    // 확장에서 오는 안전망 메시지: 선택 해제
    if ((msg as any)?.type === 'ui.clearSelection') {
      m('Host.ui.clearSelection', () => {
        appView.clearExplorerSelection();
        store.dispatch({ type: 'EXPLORER_CLEAR_SELECTION' } as any);
      });
      return;
    }

    switch (msg.type) {
      case 'buttons.lock': {
        m('Controls.buttons.lock', () => setButtonsDisabled((msg as any).payload.ids || [], true));
        break;
      }
      case 'buttons.unlock': {
        m('Controls.buttons.unlock', () =>
          setButtonsDisabled((msg as any).payload.ids || [], false),
        );
        break;
      }
      case 'initState': {
        m('Host.initState', () => {
          const logs = msg.payload.state?.logs || [];
          // (선택) 중복 루트 방지: 트리 DOM 초기화 API가 있다면 호출
          (appView as any).resetExplorerTree?.();

          store.dispatch({ type: 'INIT', logs, panelState: (msg as any).payload.panelState });
          appView.logsReset(logs);
          hostProxy.post({ v: 1, type: 'ui.requestButtons', payload: {} });

          // root 구성 및 최초 목록 요청
          store.dispatch({ type: 'EXPLORER_SET_ROOT' });
          const root = store.getState().root!;
          const treeEl = document.getElementById('explorerTree');
          if (treeEl && root && !root.el) {
            explorer.list('');
          }
        });
        break;
      }
      case 'appendLog': {
        m('Logs.append', () => appView.logsAppend(msg.payload.text));
        break;
      }
      case 'debuglog.page.response': {
        m('Logs.prepend(page.response)', () => {
          const lines: string[] = msg.payload.lines || [];
          if (lines.length) {
            // 상태 반영은 최소화(렌더는 DOM 주도)
            store.dispatch({ type: 'LOG_PREPEND', lines } as any);
            appView.logsPrepend(lines);
          }
        });
        break;
      }
      case 'debuglog.cleared': {
        m('Logs.reset(cleared)', () => {
          store.dispatch({ type: 'LOG_RESET', lines: [] } as any);
          appView.logsReset([]);
        });
        break;
      }
      case 'debuglog.copy.done': {
        // 웹뷰는 조용히 무시 (호스트가 토스트/알림 처리 가능)
        break;
      }
      case 'buttons.set': {
        m('Controls.render', () =>
          appView.renderControls(msg.payload.sections as any, {
            showLogs: store.getState().showLogs,
            showExplorer: store.getState().showExplorer,
          }),
        );
        break;
      }
      case 'git.status.response': {
        m('Git.decorate(status)', () => updateGitStatusMap((msg as any).payload.status));
        break;
      }
      case 'git.status.error': {
        uiLog.warn('Git status error: ' + String((msg as any)?.payload?.message || 'unknown'));
        break;
      }
      case 'ui.toggleLogs': {
        m('Toggle.logs', () => {
          store.dispatch({ type: 'TOGGLE_LOGS' });
          hostProxy.post({ v: 1, type: 'ui.requestButtons', payload: {} });
        });
        break;
      }
      case 'ui.toggleExplorer': {
        m('Toggle.explorer', () => {
          store.dispatch({ type: 'TOGGLE_EXPLORER' });
          if (store.getState().showExplorer) {
            hostProxy.post({ v: 1, type: 'workspace.ensure', payload: {} });
            if (!store.getState().root) {
              (appView as any).resetExplorerTree?.();
              store.getState().nodesByPath.clear();
              store.dispatch({ type: 'EXPLORER_SET_ROOT' });
            }
            explorer.list('');
          }
          hostProxy.post({ v: 1, type: 'ui.requestButtons', payload: {} });
        });
        break;
      }
      case 'explorer.list.result': {
        m('Explorer.renderChildren(list.result)', () => {
          const rel = String(msg.payload.path || '');
          const node = rel ? getNodeByPath(rel) : store.getState().root!;
          if (!node) return;
          appView.renderChildren(node, msg.payload.items);
          if (node === store.getState().root && store.getState().selected.length === 0) {
            store.dispatch({ type: 'EXPLORER_SELECT', node, multi: false } as any);
            appView.renderBreadcrumb(store.getState().explorerPath, nodesByPath());
          }
          // 목록이 갱신될 때마다 현재 보이는 노드에 Git 데코레이션 재적용
          applyGitDecorations();
        });
        break;
      }
      case 'explorer.ok': {
        m('Explorer.ok.refreshParent', () => {
          const path = String(msg.payload.path || '');
          const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
          explorer.list(parent);
        });
        break;
      }
      case 'explorer.fs.changed': {
        m('Explorer.fs.changed.refreshParent', () => {
          const changedRel = String(msg.payload.path || '');
          const parent = changedRel.includes('/')
            ? changedRel.slice(0, changedRel.lastIndexOf('/'))
            : '';
          explorer.list(parent);
        });
        break;
      }
      case 'explorer.root.changed': {
        m('Explorer.root.changed.reset', () => {
          (appView as any).resetExplorerTree?.();
          store.getState().nodesByPath.clear();
          store.dispatch({ type: 'EXPLORER_SET_ROOT' });
          appView.renderBreadcrumb('', nodesByPath());
          explorer.list('');
          // 루트 재설정 후에도 데코레이션 유지
          applyGitDecorations();
        });
        break;
      }
      case 'explorer.error': {
        alert(`탐색기 작업 실패: ${msg.payload.message || msg.payload.op || 'unknown'}`);
        break;
      }
    }
  });

  // bootstrap
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () =>
      m('UI.ready(DOMContentLoaded)', () =>
        hostProxy.post({ v: 1, type: 'ui.ready', payload: {} }),
      ),
    );
  } else {
    m('UI.ready(immediate)', () => hostProxy.post({ v: 1, type: 'ui.ready', payload: {} }));
  }
  setTimeout(() => {
    m('Bootstrap.applyLayout', () => appView.applyLayout(store.getState()));
    m('Bootstrap.ensureCtrlContentFit', () => (appView as any).ensureCtrlContentFit?.());
    m('Bootstrap.requestButtons', () =>
      hostProxy.post({ v: 1, type: 'ui.requestButtons', payload: {} }),
    );
    // 최초 1회 Git 상태 요청(옵션)
    m('Bootstrap.gitStatus', () =>
      hostProxy.post({ v: 1, type: 'git.status.request', payload: {} as any }),
    );
  }, 0);

  // ExplorerView에서 발생시키는 전역 이벤트(버튼 클릭)
  window.addEventListener('edge:git.status', () =>
    m('UI.gitStatus.click', () =>
      hostProxy.post({ v: 1, type: 'git.status.request', payload: {} as any }),
    ),
  );
})();
