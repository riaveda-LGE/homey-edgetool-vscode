import type { Kind,TreeNode } from '../../types/model.js';
import { ContextMenu } from './ContextMenu.js';
import { TreeView } from './TreeView.js';

export class ExplorerView {
  private pathEl!: HTMLElement;
  private treeEl!: HTMLElement;
  private tree!: TreeView;
  private ctx!: ContextMenu;

  constructor(
    private container: HTMLElement,
    private getNodeByPath: (p: string) => TreeNode | undefined,
    private registerNode: (n: TreeNode) => void,
    private onList: (path: string) => void,
    private onOpen: (node: TreeNode) => void,
    private onToggle: (node: TreeNode) => void,
    private onSelect: (node: TreeNode, multi: boolean) => void,
    private onCreate: (full: string, isFile: boolean) => void,
    private onDelete: (nodes: TreeNode[]) => void,
  ) {
    this.container.innerHTML = `
      <div id="explorerBar">
        <div id="explorerTitle">Explorer</div>
        <div id="explorerPath"></div>
      </div>
      <div id="explorerTree" role="tree" tabindex="0"></div>
    `;
    this.pathEl = this.container.querySelector('#explorerPath')!;
    this.treeEl = this.container.querySelector('#explorerTree')!;
    // ✅ TreeView에 onDelete 전달 (Delete 키 처리)
    this.tree = new TreeView(this.treeEl, this.getNodeByPath, this.onToggle, this.onOpen, this.onSelect, this.onDelete);
    this.ctx = new ContextMenu(
      this.container,
      (n) => this.onOpen(n),
      (_dir, isFile, full) => this.onCreate(full, isFile),
      (nodes) => this.onDelete(nodes)
    );

    // 우클릭 캡처
    document.addEventListener('contextmenu', (e) => {
      const t = e.target as HTMLElement | null;
      if (!t || !t.closest('#explorer')) return;
      e.preventDefault(); e.stopPropagation();
      const li = t.closest('.tree-node') as HTMLElement | null;
      const node = li ? this.getNodeByPath(li.dataset.path || '') ?? null : null;
      const me = e as MouseEvent;
      this.ctx.open(me.clientX, me.clientY, node);
    }, true);
  }

  renderBreadcrumb(path: string, nodesByPath: Map<string, TreeNode>) {
    this.pathEl.innerHTML = '';
    const segs = path ? path.split('/').filter(Boolean) : [];
    const rootCrumb = document.createElement('span');
    rootCrumb.className = 'crumb'; rootCrumb.textContent = 'workspace';
    rootCrumb.addEventListener('click', () => this.onList(''));
    this.pathEl.appendChild(rootCrumb);

    let acc = '';
    segs.forEach((seg) => {
      const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '/';
      this.pathEl.appendChild(sep);
      acc = [acc, seg].filter(Boolean).join('/').replace(/\/+/g,'/');
      const c = document.createElement('span'); c.className = 'crumb'; c.textContent = seg;
      c.addEventListener('click', () => this.onList(acc));
      this.pathEl.appendChild(c);
    });
  }

  renderChildren(node: TreeNode, items: { name: string; kind: Kind }[]) {
    this.tree.renderChildren(node, items, this.registerNode);
  }

  updateExpanded(node: TreeNode) { this.tree.updateExpanded(node); }
}
