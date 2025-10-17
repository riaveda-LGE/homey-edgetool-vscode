export class LogService {
  private container: HTMLElement | null = null;
  private body: HTMLElement | null = null;

  constructor(private root: HTMLElement) {}

  private ensureContainer() {
    if (!this.container) {
      // 외곽 컨테이너
      this.container = document.createElement('div');
      this.container.id = 'logContainer';
      this.container.className = 'log-container';

      // 내부 뷰(헤더 + 본문)
      this.container.innerHTML = `
        <div id="logBar">
          <div id="logTitle">Debugging Log</div>
        </div>
        <div id="logBody" class="log-body" role="log" aria-live="polite"></div>
      `;

      this.root.appendChild(this.container);
      this.body = this.container.querySelector('#logBody') as HTMLElement;
    } else if (!this.body) {
      this.body = this.container.querySelector('#logBody') as HTMLElement;
    }
  }

  reset(lines?: string[]) {
    this.ensureContainer();
    if (this.body) this.body.innerHTML = '';
    if (Array.isArray(lines)) lines.forEach((l) => this.append(l));
  }

  append(line: string) {
    this.ensureContainer();
    const div = document.createElement('div');
    div.className = 'log-line';
    if (/\[E\]/.test(line)) div.style.color = '#ff6b6b';
    div.textContent = line;
    (this.body as HTMLElement).appendChild(div);

    // 스크롤 맨 아래로
    this.container!.scrollTop = this.container!.scrollHeight;
  }

  get element() { return this.container; }
}
