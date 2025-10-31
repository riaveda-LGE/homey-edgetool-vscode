export type Kind = 'file' | 'folder';

export type TreeNode = {
  path: string;
  name: string;
  kind: Kind;
  el?: HTMLElement;
  parent?: TreeNode | null;
  children?: TreeNode[];
  expanded?: boolean;
  loaded?: boolean;
  selected?: boolean;
};

export type SectionItem = { id: string; label: string; desc?: string; disabled?: boolean };
export type SectionDTO = { title: string; items: SectionItem[] };

export type PanelStatePersist = {
  showExplorer: boolean;
  showLogs: boolean;
  controlHeight: number;
  splitterPosition?: number;
};

export type AppState = {
  showLogs: boolean;
  showExplorer: boolean;
  explorerPath: string;
  root: TreeNode | null;
  nodesByPath: Map<string, TreeNode>;
  selected: TreeNode[];
  logs: string[];
  panel: PanelStatePersist | null;
};
