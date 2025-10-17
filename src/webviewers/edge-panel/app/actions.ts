// src/webviewers/edge-panel/app/actions.ts
import type { PanelStatePersist, TreeNode } from '../types/model.js';

export type Action =
  | { type: 'INIT'; logs?: string[]; panelState?: PanelStatePersist }
  | { type: 'TOGGLE_LOGS' }
  | { type: 'TOGGLE_EXPLORER' }
  | { type: 'SET_SECTIONS' }
  | { type: 'LOG_APPEND'; text: string }
  | { type: 'EXPLORER_SET_ROOT' }
  | { type: 'EXPLORER_LIST_RESULT' }
  | { type: 'EXPLORER_SELECT'; node: TreeNode; multi: boolean }
  | { type: 'EXPLORER_EXPANDED'; node: TreeNode; expanded: boolean }
  | { type: 'EXPLORER_CLEAR_SELECTION' };
