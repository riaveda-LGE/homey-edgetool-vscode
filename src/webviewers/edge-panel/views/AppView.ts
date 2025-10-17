import { LogService } from '../services/LogService.js';
import type { AppState, PanelStatePersist, SectionDTO, TreeNode } from '../types/model.js';
import { ExplorerView } from './Explorer/ExplorerView.js';
import { ensureContentSplitter,ensureExplorerContainer } from './Layout/Panel.js';
import { bindContentSplitter,bindVerticalSplitter } from './Layout/Splitter.js';
import { LogsView } from './Logs/LogsView.js';

export class AppView {
  private splitter: HTMLElement;
  private content: HTMLElement;

  private explorerEl: HTMLElement | null = null;
  private explorerView: ExplorerView | null = null;
  private contentSplitter: HTMLElement | null = null;
  private logsView: LogsView;

  private userAdjustedCtrl = false;
  private contentSplitterBound = false; // 가운데 스플리터 바인딩 여부

  // 내부 패널 최소 높이
  private readonly MIN_TOP = 80;     // Explorer
  private readonly MIN_BOTTOM = 80;  // Logs

  // 선택: 컨트롤 영역 자동 높이 보정용 ResizeObserver 보관
  private _sectionsRO?: ResizeObserver;

  // Logs 높이 유지용: 마지막으로 적용된 bottom px 캐시
  private lastBottomPx: number | null = null;

  constructor(
    private root: HTMLElement,
    controlsEl: HTMLElement,
    sectionsEl: HTMLElement,
    private onControlsClick: (id: string) => void,
    private onRequestButtons: () => void,
    private onList: (path: string) => void,
    private getNodeByPath: (p: string) => TreeNode | undefined,
    private registerNode: (n: TreeNode) => void,
    private onOpen: (n: TreeNode) => void,
    private onToggle: (n: TreeNode) => void,
    private onSelect: (n: TreeNode, multi: boolean) => void,
    private onCreate: (full: string, isFile: boolean) => void,
    private onDelete: (nodes: TreeNode[]) => void,
    private onSavePanel: (p: PanelStatePersist) => void,
  ) {
    this.splitter = document.getElementById('splitter')!;
    this.content = document.getElementById('content')!;

    // 로그 컨테이너/뷰는 항상 생성(컨테이너는 reset/append 시에 DOM에 붙음)
    this.logsView = new LogsView(new LogService(this.content));

    // Explorer·내부 스플리터도 고정 DOM으로 미리 생성
    this.explorerEl = ensureExplorerContainer(this.content);
    this.contentSplitter = ensureContentSplitter(this.content);

    // 상단 스플리터(컨트롤 영역 높이 조절) — 증분 기반 조절 + 내부 재배치
    bindVerticalSplitter(this.splitter, (dy, commit) => {
      const cur = this.cssPx('--ctrl-h');
      const maxPx = Math.floor(window.innerHeight * 0.5);
      const minPx = 120;
      const next = Math.min(Math.max(cur + dy, minPx), maxPx);
      document.documentElement.style.setProperty('--ctrl-h', `${next}px`);
      this.userAdjustedCtrl = true;

      // Controls↔Content 높이 변경 시, Logs 유지 재배치(캐시 기반)
      this.reflowAfterCtrlMove(commit);
      if (commit) this.savePanelState();
    });

    // 창 리사이즈 시 컨트롤 박스 자동 맞춤 + Logs 고정 재배치
    window.addEventListener('resize', () => {
      this.ensureCtrlContentFit();
      this.reflowAfterCtrlMove(false);
    });

    // ResizeObserver 안전 생성
    const RO: typeof ResizeObserver | undefined = (window as any).ResizeObserver;
    if (RO && sectionsEl) {
      this._sectionsRO = new RO(() => {
        this.ensureCtrlContentFit();
        this.reflowAfterCtrlMove(false);
      });
      this._sectionsRO.observe(sectionsEl);
    }
  }

  renderControls(sections: SectionDTO[], toggles: { showLogs: boolean; showExplorer: boolean }) {
    const sectionsEl = document.getElementById('sections')!;
    sectionsEl.innerHTML = '';
    sections.forEach((sec) => {
      const card = document.createElement('div'); card.className = 'section-card';
      const h = document.createElement('h4'); h.textContent = sec.title; card.appendChild(h);
      const body = document.createElement('div'); body.className = 'section-body';
      sec.items.forEach((it) => {
        const b = document.createElement('button'); b.className = 'btn'; b.title = it.desc || it.label; b.textContent = it.label;
        if (it.id === 'panel.toggleLogs' && toggles.showLogs) b.classList.add('btn-on');
        if (it.id === 'panel.toggleExplorer' && toggles.showExplorer) b.classList.add('btn-on');
        b.addEventListener('click', () => this.onControlsClick(it.id));
        body.appendChild(b);
      });
      card.appendChild(body); sectionsEl.appendChild(card);
    });
  }

  applyLayout(state: AppState) {
    this.root.classList.toggle('show-logs', state.showLogs);
    this.root.classList.toggle('show-explorer', state.showExplorer);
    this.root.classList.toggle('show-both', state.showLogs && state.showExplorer);

    // showLogs가 true인데 아직 컨테이너가 없다면 빈 컨테이너 즉시 생성
    if (state.showLogs && !this.logsView.element) {
      this.logsView.reset([]);
    }

    // Explorer는 한 번만 인스턴스화
    if (!this.explorerView) {
      this.explorerView = new ExplorerView(
        this.explorerEl!,
        this.getNodeByPath,
        this.registerNode,
        (p) => this.onList(p),
        (n) => this.onOpen(n),
        (n) => this.onToggle(n),
        (n, m) => this.onSelect(n, m),
        (full, isFile) => this.onCreate(full, isFile),
        (nodes) => this.onDelete(nodes),
      );
    }

    // 가시성 & 접근성 토글
    const setVisible = (el: HTMLElement | null, v: boolean, opts?: { focusTarget?: HTMLElement | null }) => {
      if (!el) return;
      el.style.display = v ? '' : 'none';
      el.setAttribute('aria-hidden', v ? 'false' : 'true');
      if (opts?.focusTarget) {
        opts.focusTarget.setAttribute('tabindex', v ? '0' : '-1');
      }
    };

    const treeEl = document.getElementById('explorerTree') as HTMLElement | null;
    setVisible(this.explorerEl, state.showExplorer, { focusTarget: treeEl });
    setVisible(this.logsView.element as HTMLElement, state.showLogs);

    // 내부 스플리터 표시 토글
    if (this.contentSplitter) {
      this.contentSplitter.style.display = (state.showExplorer && state.showLogs) ? '' : 'none';
    }

    // DOM 순서 안전핀
    const logEl = this.logsView.element as HTMLElement | null;
    if (logEl) {
      if (this.contentSplitter && this.contentSplitter.nextSibling !== logEl) {
        this.content.insertBefore(this.contentSplitter, logEl);
      }
      if (this.explorerEl && this.explorerEl.nextSibling !== this.contentSplitter) {
        this.content.insertBefore(this.explorerEl, this.contentSplitter!);
      }
    }

    // 가운데 스플리터 드래그 바인딩 (한 번만)
    if ((state.showExplorer && state.showLogs) && this.contentSplitter && !this.contentSplitterBound) {
      const MIN_TOP = this.MIN_TOP;
      const MIN_BOTTOM = this.MIN_BOTTOM;

      const setRows = (topPx: number, bottomPx: number, commit: boolean) => {
        this.setContentRows(topPx, bottomPx, commit);
      };

      const getSizes = () => {
        const topRect = this.explorerEl!.getBoundingClientRect();
        const bottomRect = (this.logsView.element as HTMLElement).getBoundingClientRect();
        return {
          top: topRect.height,
          bottom: bottomRect.height,
          minTop: MIN_TOP,
          minBottom: MIN_BOTTOM,
        };
      };

      bindContentSplitter(this.contentSplitter, getSizes, setRows);
      this.contentSplitterBound = true;

      // 저장된 비율이 있으면 초기 반영, 없으면 현재 치수 또는 50/50로 보정
      const panel = (window as any).__edgePanelState as PanelStatePersist | undefined;
      const savedRatio = panel?.splitterPosition ?? (null as number | null);
      if (savedRatio != null && !Number.isNaN(savedRatio)) {
        const contentRect = this.content.getBoundingClientRect();
        const usable = contentRect.height - this.cssPx('--splitter-h');
        const topPx = Math.max(0, usable * savedRatio);
        const bottomPx = Math.max(0, usable - topPx);
        this.setContentRows(topPx, bottomPx, false);
      } else {
        const sz = getSizes();
        if (sz.top + sz.bottom < 8) {
          const contentRect = this.content.getBoundingClientRect();
          const usable = Math.max(0, contentRect.height - this.cssPx('--splitter-h'));
          const half = Math.floor(usable / 2);
          this.setContentRows(Math.max(MIN_TOP, half), Math.max(MIN_BOTTOM, usable - half), false);
        } else {
          this.setContentRows(sz.top, sz.bottom, false);
        }
      }
    }

    // 하나만 보일 때는 grid 템플릿 기본값
    if (!(state.showExplorer && state.showLogs)) {
      this.content.style.gridTemplateRows = '';
    }

    this.ensureCtrlContentFit();

    // 초기 보정(Logs 유지)
    this.reflowAfterCtrlMove(false);
  }

  /** 상단 분리바 이동/리사이즈 등으로 Content 높이가 달렸을 때
   *  Logs 높이는 유지(가능하면), Explorer만 증감 */
  private reflowAfterCtrlMove(commit: boolean) {
    if (!this.contentSplitter || !this.explorerEl || !this.logsView.element) return;
    const bothVisible =
      this.root.classList.contains('show-explorer') &&
      this.root.classList.contains('show-logs');
    if (!bothVisible) return;

    const contentRect = this.content.getBoundingClientRect();
    const splitterH = this.cssPx('--splitter-h');
    const usable = Math.max(0, contentRect.height - splitterH);

    // 유지하고 싶은 Logs 높이: DOM 측정 대신 마지막 적용값을 사용
    const desiredBottom =
      this.lastBottomPx != null
        ? this.lastBottomPx
        : (this.logsView.element as HTMLElement).getBoundingClientRect().height;

    // 하한/상한(최소 보장 + 상단 최소 확보)
    const upper = Math.max(0, usable - this.MIN_TOP);              // Logs가 가질 수 있는 최대
    const lower = Math.max(0, Math.min(this.MIN_BOTTOM, upper));   // 공간이 허용하는 선에서의 최소

    // 가능하면 '유지', 불가 시 범위 내로 클램프
    let bottomPx = Math.max(lower, Math.min(desiredBottom, upper));
    let topPx = usable - bottomPx;

    // 경계 보정
    topPx = Math.max(0, Math.floor(topPx));
    bottomPx = Math.max(0, Math.floor(bottomPx));

    this.setContentRows(topPx, bottomPx, commit);
  }

  /** grid-template-rows를 px로 고정 적용(+ 캐시 갱신) */
  private setContentRows(topPx: number, bottomPx: number, commit: boolean) {
    this.content.style.gridTemplateRows =
      `${Math.max(0, Math.floor(topPx))}px var(--splitter-h) ${Math.max(0, Math.floor(bottomPx))}px`;
    // 마지막 bottom px 캐시
    this.lastBottomPx = Math.max(0, Math.floor(bottomPx));
    if (commit) this.savePanelState();
  }

  private cssPx(varName: string): number {
    const v = getComputedStyle(document.documentElement).getPropertyValue(varName);
    const n = Number(v.replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  ensureCtrlContentFit() {
    if (this.userAdjustedCtrl) return;
    const sectionsEl = document.getElementById('sections')!;
    const contentHeight = sectionsEl.scrollHeight + 32;
    const maxPx = Math.floor(window.innerHeight * 0.5);
    const next = Math.min(contentHeight, maxPx);
    document.documentElement.style.setProperty('--ctrl-h', `${next}px`);
  }

  renderBreadcrumb(path: string, nodesByPath: Map<string, TreeNode>) {
    this.explorerView?.renderBreadcrumb(path, nodesByPath);
  }

  renderChildren(node: TreeNode, items: { name: string; kind: 'file' | 'folder' }[]) {
    this.explorerView?.renderChildren(node, items);
  }

  logsReset(lines?: string[]) { this.logsView.reset(lines); }
  logsAppend(line: string) { this.logsView.append(line); }

  savePanelState() {
    const explorerEl = document.getElementById('explorer') as HTMLElement | null;
    const logContainer = document.getElementById('logContainer') as HTMLElement | null;
    let splitterPosition: number | undefined;

    if (explorerEl && logContainer) {
      const e = explorerEl.getBoundingClientRect().height;
      const l = logContainer.getBoundingClientRect().height;
      const total = e + l;
      if (total > 0) splitterPosition = e / total;
      (window as any).__edgePanelState = { splitterPosition };
    }

    const controlHeight = this.cssPx('--ctrl-h');
    this.onSavePanel({
      showExplorer: this.root.classList.contains('show-explorer'),
      showLogs: this.root.classList.contains('show-logs'),
      controlHeight,
      splitterPosition
    });
  }

  /** 외부(웹뷰 밖 클릭/ESC 등)에서 선택 해제를 요청할 때 DOM만 정리 */
  public clearExplorerSelection() {
    const selectedEls = Array.from(document.querySelectorAll('#explorer .tree-node.selected')) as HTMLElement[];
    selectedEls.forEach(el => {
      el.classList.remove('selected');
      el.removeAttribute('aria-selected');
    });
  }

  /** 트리 루트 DOM을 전부 비움(중복 root 방지) */
  public resetExplorerTree() {
    const tree = document.getElementById('explorerTree') as HTMLElement | null;
    if (tree) tree.innerHTML = '';
    this.clearExplorerSelection();
  }
}
