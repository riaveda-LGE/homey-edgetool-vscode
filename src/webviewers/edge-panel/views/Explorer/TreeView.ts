// src/webviewers/edge-panel/views/Explorer/TreeView.ts
import type { Kind,TreeNode } from '../../types/model.js';

export class TreeView {
  private selectedEl: HTMLElement | null = null;

  constructor(
    private treeEl: HTMLElement,
    private getNodeByPath: (p: string) => TreeNode | undefined,
    private onToggle: (n: TreeNode) => void,
    private onOpen: (n: TreeNode) => void,
    private onSelect: (n: TreeNode, multi: boolean) => void,
    private onDelete: (nodes: TreeNode[]) => void,
  ) {
    if (!this.treeEl.dataset._bound) {
      this.treeEl.dataset._bound = '1';
      this.treeEl.addEventListener('keydown', this.onKey);

      this.treeEl.addEventListener('click', (e) => {
        const nodeEl = (e.target as HTMLElement).closest('.tree-node') as HTMLElement | null;
        if (!nodeEl) return;
        const node = this.getNodeByPath(nodeEl.dataset.path || '');
        if (!node) return;

        // 선택 표시 업데이트 + 포커스 고정
        this.setSelected(nodeEl);
        this.treeEl.focus();

        this.onSelect(node, (e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey);
      });

      this.treeEl.addEventListener('dblclick', (e) => {
        const nodeEl = (e.target as HTMLElement).closest('.tree-node') as HTMLElement | null;
        if (!nodeEl) return;
        const node = this.getNodeByPath(nodeEl.dataset.path || '');
        if (!node) return;

        // 더블클릭 시에도 선택 보장
        this.setSelected(nodeEl);
        this.treeEl.focus();

        if (node.kind === 'folder') {
          // 루트는 토글 금지(항상 펼침)
          if (node.path === '') return;
          node.expanded = !node.expanded;
          this.updateExpanded(node);
          this.onToggle(node);
        } else {
          this.onOpen(node);
        }
      });
    }
  }

  private setSelected(el: HTMLElement) {
    if (this.selectedEl === el) return;
    if (this.selectedEl) {
      this.selectedEl.classList.remove('selected');
      this.selectedEl.removeAttribute('aria-selected');
    }
    this.selectedEl = el;
    this.selectedEl.classList.add('selected');
    this.selectedEl.setAttribute('aria-selected', 'true');
  }

  private onKey = (e: KeyboardEvent) => {
    const items = Array.from(this.treeEl.querySelectorAll('.tree-node')) as HTMLElement[];
    const idx = items.findIndex((el) => el.classList.contains('selected'));

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[Math.min(items.length - 1, idx + 1)]?.click();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[Math.max(0, idx - 1)]?.click();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      items[idx]?.dispatchEvent(new Event('dblclick'));
      return;
    }

    // Delete / Backspace 로 삭제
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const selectedEls = Array.from(this.treeEl.querySelectorAll('.tree-node.selected')) as HTMLElement[];
      const selectedNodes = selectedEls
        .map(el => this.getNodeByPath(el.dataset.path || ''))
        .filter((n): n is TreeNode => !!n);

      if (selectedNodes.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        this.onDelete(selectedNodes);
      }
    }
  };

  nodeLabel(node: TreeNode) {
    const wrap = document.createElement('div');
    wrap.className = 'tree-node';
    wrap.dataset.path = node.path;
    wrap.setAttribute('role', 'treeitem');
    wrap.setAttribute('aria-expanded', node.kind === 'folder' ? String(!!node.expanded) : 'false');

    const line = document.createElement('div'); line.className = 'tn-line';
    const chev = document.createElement('span'); chev.className = 'tn-chevron'; chev.setAttribute('aria-hidden', 'true');
    const icon = document.createElement('span'); icon.className = 'tn-icon';
    const label = document.createElement('span'); label.className = 'tn-label'; label.textContent = node.name;

    if (node.kind === 'folder') {
      icon.textContent = '📁';
      // ▶︎ 루트 토글 금지, 그 외엔 즉시 DOM 토글 + 상위(onToggle)로 데이터 로딩 요청
      chev.addEventListener('click', (e) => {
        e.stopPropagation();
        if (node.path === '') return; // 루트는 항상 펼침
        node.expanded = !node.expanded;
        this.updateExpanded(node);
        this.onToggle(node);
      });
    } else {
      icon.textContent = '📄';
      chev.classList.add('tn-empty');
    }
    line.appendChild(chev); line.appendChild(icon); line.appendChild(label);
    wrap.appendChild(line);

    if (node.kind === 'folder') {
      const group = document.createElement('div');
      group.className = 'tn-children';
      group.setAttribute('role', 'group');
      if (!node.expanded && node.path !== '') {
        // 루트는 항상 펼침
        group.style.display = 'none';
      }
      wrap.appendChild(group);
    }

    if ((node as any).selected) {
      this.setSelected(wrap);
    }

    return wrap;
  }

  mountNode(parent: HTMLElement, node: TreeNode) {
    let el = node.el;
    if (!el) { el = this.nodeLabel(node); node.el = el; }
    parent.appendChild(el);
  }

  ensureChildrenContainer(node: TreeNode): HTMLElement | null {
    if (node.kind !== 'folder' || !node.el) return null;
    return node.el.querySelector('.tn-children') as HTMLElement | null;
  }

  renderChildren(node: TreeNode, items: { name: string; kind: Kind }[], register: (n: TreeNode) => void) {
    if (!node.el) this.mountNode(this.treeEl, node);
    const group = this.ensureChildrenContainer(node); if (!group) return;
    group.innerHTML = '';
    const existing = new Map(node.children?.map(c => [c.name, c]) || []);
    node.children = [];

    items.sort((a,b)=> a.kind===b.kind ? a.name.localeCompare(b.name, undefined, {numeric:true}) : a.kind==='folder' ? -1 : 1);

    items.forEach((it) => {
      let child = existing.get(it.name);
      if (!child) {
        const path = (node.path ? node.path + '/' : '') + it.name;
        child = { path, name: it.name, kind: it.kind, parent: node, children: [], expanded: false, loaded: false, selected: false };
        register(child);
      }
      this.mountNode(group, child);

      if ((child as any).selected && child.el) {
        this.setSelected(child.el);
      }

      node.children!.push(child);
    });

    node.loaded = true;
    node.expanded = true;            // 목록을 그렸다면 펼쳐진 상태
    this.updateExpanded(node);
  }

  updateExpanded(node: TreeNode) {
    if (!node.el) return;
    const group = this.ensureChildrenContainer(node);
    const isExpanded = node.path === '' ? true : !!node.expanded; // 루트는 항상 true
    node.el.setAttribute('aria-expanded', node.kind === 'folder' ? String(isExpanded) : 'false');
    node.el.classList.toggle('expanded', isExpanded);
    if (group) group.style.display = isExpanded ? '' : 'none';
  }
}
