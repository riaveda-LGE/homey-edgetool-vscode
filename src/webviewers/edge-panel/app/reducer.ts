import { DEBUG_LOG_MEMORY_MAX } from '../../../shared/const.js';
import type { AppState, TreeNode } from '../types/model.js';
import type { Action } from './actions.js';

export function createInitialState(): AppState {
  return {
    showLogs: false,
    showExplorer: true,
    explorerPath: '',
    root: null,
    nodesByPath: new Map(),
    selected: [],
    logs: [],
    panel: null,
  };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'INIT': {
      if (action.logs) {
        state.logs =
          action.logs.length > DEBUG_LOG_MEMORY_MAX
            ? action.logs.slice(-DEBUG_LOG_MEMORY_MAX)
            : [...action.logs];
      }
      if (action.panelState) state.panel = action.panelState;
      return state;
    }
    case 'TOGGLE_LOGS':
      state.showLogs = !state.showLogs;
      return state;
    case 'TOGGLE_EXPLORER':
      state.showExplorer = !state.showExplorer;
      return state;
    case 'SET_SECTIONS':
      return state; // view에서만 사용
    case 'LOG_APPEND': {
      state.logs.push(action.text);
      if (state.logs.length > DEBUG_LOG_MEMORY_MAX) {
        state.logs.splice(0, state.logs.length - DEBUG_LOG_MEMORY_MAX);
      }
      return state;
    }
    case 'LOG_PREPEND': {
      const next = [...action.lines, ...state.logs];
      state.logs = next.length > DEBUG_LOG_MEMORY_MAX ? next.slice(-DEBUG_LOG_MEMORY_MAX) : next;
      return state;
    }
    case 'LOG_RESET': {
      state.logs = action.lines ? action.lines.slice(-DEBUG_LOG_MEMORY_MAX) : [];
      return state;
    }
    case 'EXPLORER_SET_ROOT': {
      const root: TreeNode = {
        path: '',
        name: 'workspace',
        kind: 'folder',
        parent: null,
        children: [],
        expanded: true,
        loaded: false,
        selected: false,
      };
      state.root = root;
      state.nodesByPath.set('', root);
      return state;
    }
    case 'EXPLORER_LIST_RESULT': {
      return state; // 실제 DOM 렌더에서 처리
    }
    case 'EXPLORER_SELECT': {
      const n = action.node;
      if (action.multi) {
        const i = state.selected.indexOf(n);
        if (i >= 0) state.selected.splice(i, 1);
        else state.selected.push(n);
      } else {
        state.selected.forEach((x) => x.el?.classList.remove('selected'));
        state.selected = [n];
      }
      if (state.selected.length === 1 && state.selected[0].kind === 'folder')
        state.explorerPath = state.selected[0].path;
      return state;
    }
    case 'EXPLORER_EXPANDED': {
      action.node.expanded = action.expanded;
      return state;
    }
    // ✅ 바깥 클릭/ESC에서 선택 초기화
    case 'EXPLORER_CLEAR_SELECTION': {
      state.selected.forEach((x) => x.el?.classList.remove('selected'));
      state.selected = [];
      return state;
    }
    default:
      return state;
  }
}
