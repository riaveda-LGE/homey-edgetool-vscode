// src/webviewers/edge-panel/views/Explorer/ContextMenu.ts
import type { TreeNode } from '../../types/model.js';

export class ContextMenu {
  private el!: HTMLElement;
  private listEl!: HTMLElement;
  private formEl!: HTMLElement;
  private formTitleEl!: HTMLElement;
  private inputEl!: HTMLInputElement;
  private target: TreeNode | null = null;
  private mode: 'menu' | 'new-file' | 'new-folder' = 'menu';

  constructor(
    private parent: HTMLElement,
    private measureUi: <T>(name: string, fn: () => T) => T,
    private onOpen: (n: TreeNode) => void,
    private onCreate: (dir: string, file: boolean, name: string) => void,
    private onDelete: (nodes: TreeNode[]) => void,
  ) {
    this.ensure();

    // 메뉴 외부 클릭 시 닫기
    document.addEventListener('click', (e) => {
      if (!this.el.hidden && !this.el.contains(e.target as any)) this.close();
    });

    // 전역 Esc 처리(메뉴 열려 있을 때)
    document.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') this.close();
    });
  }

  private ensure() {
    let el = this.parent.querySelector('#ctxMenu') as HTMLElement | null;
    if (!el) {
      el = document.createElement('div');
      el.id = 'ctxMenu';
      el.setAttribute('hidden', '');
      // 삭제 확정 단계 없이 바로 삭제되도록 간소화된 템플릿
      el.innerHTML = `
        <div class="menu-list">
          <div class="menu-item" data-cmd="open">열기</div>
          <hr/>
          <div class="menu-item" data-cmd="new-file">새 파일</div>
          <div class="menu-item" data-cmd="new-folder">새 폴더</div>
          <hr/>
          <div class="menu-item" data-cmd="delete">삭제</div>
        </div>
        <div class="menu-form" hidden>
          <div class="menu-form-title"></div>
          <input id="ctxInput" type="text" spellcheck="false" />
          <div class="menu-actions">
            <button class="btn small" data-action="ok">확인</button>
            <button class="btn small ghost" data-action="cancel">취소</button>
          </div>
        </div>`;
      this.parent.appendChild(el);
    }

    this.el = el;
    this.listEl = el.querySelector('.menu-list')!;
    this.formEl = el.querySelector('.menu-form')!;
    this.formTitleEl = el.querySelector('.menu-form-title')!;
    this.inputEl = el.querySelector('#ctxInput') as HTMLInputElement;

    if (!(this.el as any)._bound) {
      (this.el as any)._bound = 1;

      // 버튼 클릭들
      this.el.addEventListener('click', (e) => {
        this.measureUi('ContextMenu.click', () => {
          const actionEl = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
          if (actionEl) {
            const a = actionEl.dataset.action;
            if (a === 'ok') this.submitCreate();
            if (a === 'cancel') this.showMenuList();
            return;
          }
          const btn = (e.target as HTMLElement).closest('.menu-item') as HTMLElement | null;
          if (!btn) return;
          const cmd = (btn.dataset as any).cmd as string;

          if (cmd === 'open' && this.target) {
            this.onOpen(this.target);
            this.close();
          }
          if (cmd === 'new-file') this.showCreateForm(true);
          if (cmd === 'new-folder') this.showCreateForm(false);

          // ✅ 확인 없이 즉시 삭제
          if (cmd === 'delete') {
            if (this.target) this.onDelete([this.target]);
            this.close();
          }
        });
      });

      // ⌨️ 입력창 단축키(Enter=확인, Esc=취소) — 중복 바인딩 방지
      if (!(this.inputEl as any)._kbdBound) {
        this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.submitCreate();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            this.showMenuList();
          }
        });
        (this.inputEl as any)._kbdBound = true;
      }
    }
  }

  private baseDir(): string {
    if (!this.target) return '';
    return this.target.kind === 'folder' ? this.target.path : (this.target.parent?.path ?? '');
  }

  private showMenuList() {
    this.measureUi('ContextMenu.showMenu', () => {
      this.mode = 'menu';
      this.listEl.hidden = false;
      this.formEl.hidden = true;
    });
  }

  private showCreateForm(file: boolean) {
    this.measureUi('ContextMenu.showCreateForm', () => {
      this.mode = file ? 'new-file' : 'new-folder';
      this.listEl.hidden = true;
      this.formEl.hidden = false;
      this.formTitleEl.textContent = file ? '새 파일 이름' : '새 폴더 이름';

      // 기본값이나 예시 넣고 싶으면 value 지정 가능
      this.inputEl.value = ''; // 예: '새파일.txt'
      this.inputEl.placeholder = file ? 'example.txt' : '새폴더';

      // ✅ 보이는 프레임 이후 포커스 & 전체선택 → 바로 타이핑 가능
      setTimeout(() => {
        this.inputEl.focus();
        this.inputEl.select();
      }, 0);
    });
  }

  private submitCreate() {
    this.measureUi('ContextMenu.submitCreate', () => {
      const nm = (this.inputEl?.value || '').trim();
      if (!nm) return;
      const full = [this.baseDir(), nm].filter(Boolean).join('/').replace(/\/+/g, '/');
      this.onCreate(this.baseDir(), this.mode === 'new-file', full);
      this.close();
    });
  }

  open(x: number, y: number, target: TreeNode | null) {
    this.measureUi('ContextMenu.open', () => {
      this.target = target;
      this.showMenuList();

      const margin = 8;
      const maxX = Math.max(margin, Math.min(x, window.innerWidth - margin));
      const maxY = Math.max(margin, Math.min(y, window.innerHeight - margin));

      // 파일일 때만 "열기" 보이기
      (this.el.querySelector('[data-cmd="open"]') as HTMLElement).style.display =
        target && target.kind === 'file' ? 'block' : 'none';

      this.el.style.left = `${maxX}px`;
      this.el.style.top = `${maxY}px`;
      this.el.hidden = false;
    });
  }

  close() {
    this.measureUi('ContextMenu.close', () => {
      this.el.hidden = true;
      this.target = null;
    });
  }
}
