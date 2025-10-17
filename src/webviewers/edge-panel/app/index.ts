import { createUiLog } from '../../shared/utils.js';
import { HostBridge } from '../services/HostBridge.js';
import { ExplorerService } from '../services/ExplorerService.js';
import { PersistService } from '../services/PersistService.js';
import { createStore } from './store.js';
import { reducer, createInitialState } from './reducer.js';
import type { TreeNode } from '../types/model.js';
import type { H2W } from '../types/messages.js';
import { AppView } from '../views/AppView.js';

(function () {
  const vscode = acquireVsCodeApi();
  const host = new HostBridge(vscode);
  const uiLog = createUiLog(vscode, 'ui.edgePanel');

  const rootEl = document.getElementById('root') as HTMLElement | null;
  const controlsEl = document.getElementById('controls') as HTMLElement | null;
  const sectionsEl = document.getElementById('sections') as HTMLElement | null;
  const splitter = document.getElementById('splitter') as HTMLElement | null;
  const contentEl = document.getElementById('content') as HTMLElement | null;
  if (!rootEl || !controlsEl || !sectionsEl || !splitter || !contentEl) {
    uiLog.error('[edge-panel] missing required elements'); return;
  }

  const store = createStore(createInitialState(), reducer);
  const explorer = new ExplorerService(host);
  const persist = new PersistService(host);

  // Node registry helpers
  const nodesByPath = () => store.getState().nodesByPath;
  const getNodeByPath = (p: string) => nodesByPath().get(p);
  const registerNode = (n: TreeNode) => nodesByPath().set(n.path, n);

  const appView = new AppView(
    rootEl, controlsEl, sectionsEl,
    (id) => host.post({ v: 1, type: 'button.click', payload: { id } }),
    () => host.post({ v: 1, type: 'ui.requestButtons', payload: {} }),
    (path) => explorer.list(path),
    (p) => getNodeByPath(p)!,
    (n) => registerNode(n),
    (n) => explorer.open(n.path),

    // ▼ 폴더 토글 처리: 루트는 토글 금지, 확장시 로딩만 요청 (DOM은 TreeView가 updateExpanded로 처리)
    (n) => {
      if (n.kind !== 'folder') return;
      if (n.path === '') {
        // 루트는 항상 펼침 고정
        n.expanded = true;
        if (!n.loaded) explorer.list(''); // 초기 한 번은 목록 로드
        return;
      }
      // 이 시점에서 TreeView가 n.expanded 값을 토글해 둠
      if (n.expanded && !n.loaded) {
        explorer.list(n.path);
      }
    },

    (n, multi) => store.dispatch({ type: 'EXPLORER_SELECT', node: n, multi } as any),
    (full, isFile) => isFile ? explorer.createFile(full) : explorer.createFolder(full),
    (nodes) => nodes.forEach(node => explorer.delete(node.path, node.kind === 'folder', true)),
    (p) => persist.save(p),
  );

  // =========================
  // 포커스 이탈 시 선택 해제 (웹뷰 쪽 즉시 처리)
  // =========================
  window.addEventListener('blur', () => {
    appView.clearExplorerSelection();
    store.dispatch({ type: 'EXPLORER_CLEAR_SELECTION' } as any);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      appView.clearExplorerSelection();
      store.dispatch({ type: 'EXPLORER_CLEAR_SELECTION' } as any);
    }
  });

  // ✅ 바깥 클릭/ESC에서 Explorer 선택 해제(+상태도 초기화)
  document.addEventListener('mousedown', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && t.closest('#explorer')) return; // Explorer 내부는 무시
    appView.clearExplorerSelection();
    store.dispatch({ type: 'EXPLORER_CLEAR_SELECTION' } as any);
  });
  document.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') {
      appView.clearExplorerSelection();
      store.dispatch({ type: 'EXPLORER_CLEAR_SELECTION' } as any);
    }
  });

  // UI subscriptions
  store.subscribe((s) => {
    appView.applyLayout(s);
  });

  // Host messages
  host.listen((msg: H2W) => {
    // 확장에서 오는 안전망 메시지: 선택 해제
    if ((msg as any)?.type === 'ui.clearSelection') {
      appView.clearExplorerSelection();
      store.dispatch({ type: 'EXPLORER_CLEAR_SELECTION' } as any);
      return;
    }

    switch (msg.type) {
      case 'initState': {
        const logs = msg.payload.state?.logs || [];
        // (선택) 중복 루트 방지: 트리 DOM 초기화 API가 있다면 호출
        (appView as any).resetExplorerTree?.();

        store.dispatch({ type: 'INIT', logs, panelState: (msg as any).payload.panelState });
        appView.logsReset(logs);
        host.post({ v: 1, type: 'ui.requestButtons', payload: {} });

        // root 구성 및 최초 목록 요청
        store.dispatch({ type: 'EXPLORER_SET_ROOT' });
        const root = store.getState().root!;
        const treeEl = document.getElementById('explorerTree');
        if (treeEl && root && !root.el) {
          explorer.list('');
        }
        break;
      }
      case 'appendLog': {
        appView.logsAppend(msg.payload.text);
        break;
      }
      case 'buttons.set': {
        appView.renderControls(msg.payload.sections as any, {
          showLogs: store.getState().showLogs,
          showExplorer: store.getState().showExplorer,
        });
        break;
      }
      case 'ui.toggleLogs': {
        store.dispatch({ type: 'TOGGLE_LOGS' });
        host.post({ v: 1, type: 'ui.requestButtons', payload: {} });
        break;
      }
      case 'ui.toggleExplorer': {
        store.dispatch({ type: 'TOGGLE_EXPLORER' });
        if (store.getState().showExplorer) {
          host.post({ v: 1, type: 'workspace.ensure', payload: {} });
          if (!store.getState().root) {
            (appView as any).resetExplorerTree?.();
            store.dispatch({ type: 'EXPLORER_SET_ROOT' });
          }
          explorer.list('');
        }
        host.post({ v: 1, type: 'ui.requestButtons', payload: {} });
        break;
      }
      case 'explorer.list.result': {
        const rel = String(msg.payload.path || '');
        const node = rel ? getNodeByPath(rel) : store.getState().root!;
        if (!node) return;
        appView.renderChildren(node, msg.payload.items);
        if (node === store.getState().root && store.getState().selected.length === 0) {
          store.dispatch({ type: 'EXPLORER_SELECT', node, multi: false } as any);
          appView.renderBreadcrumb(store.getState().explorerPath, nodesByPath());
        }
        break;
      }
      case 'explorer.ok': {
        const path = String(msg.payload.path || '');
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        explorer.list(parent);
        break;
      }
      case 'explorer.fs.changed': {
        const changedRel = String(msg.payload.path || '');
        const parent = changedRel.includes('/') ? changedRel.slice(0, changedRel.lastIndexOf('/')) : '';
        explorer.list(parent);
        break;
      }
      case 'explorer.root.changed': {
        (appView as any).resetExplorerTree?.();
        store.getState().nodesByPath.clear();
        store.dispatch({ type: 'EXPLORER_SET_ROOT' });
        appView.renderBreadcrumb('', nodesByPath());
        explorer.list('');
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
    document.addEventListener('DOMContentLoaded', () => host.post({ v: 1, type: 'ui.ready', payload: {} }));
  } else {
    host.post({ v: 1, type: 'ui.ready', payload: {} });
  }
  setTimeout(() => {
    appView.applyLayout(store.getState());
    (appView as any).ensureCtrlContentFit?.();
    host.post({ v: 1, type: 'ui.requestButtons', payload: {} });
  }, 0);
})();
