export class LogService {
  private container: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private actions: { clearBtn: HTMLButtonElement; copyBtn: HTMLButtonElement } | null = null;
  private loadingOlder = false;
  private m: <T>(name: string, fn: () => T) => T;

  // ── 세그먼트 토글 상태 (10초 간격) ──────────────────────────────
  private lastTs: number | undefined;
  private seg: 0 | 1 = 0;
  private readonly GAP_MS = 10_000; // 10초
  // ───────────────────────────────────────────────────────────────

  constructor(
    private root: HTMLElement,
    private onLoadOlder?: () => void,
    private onClear?: () => void,
    private onCopy?: () => void,
    measureUi?: <T>(name: string, fn: () => T) => T,
  ) {
    this.m = measureUi ?? ((_, fn) => fn());
  }

  private ensureContainer() {
    if (!this.container) {
      this.m('LogService.ensureContainer', () => {
        // 외곽 컨테이너
        this.container = document.createElement('div');
        this.container.id = 'logContainer';
        this.container.className = 'log-container';

        // 내부 뷰(헤더 + 본문)
        this.container.innerHTML = `
        <div id="logBar">
          <div id="logTitle">Debugging Log</div>
          <div id="logActions" aria-label="log actions">
            <button id="logCopy" class="btn small ghost" title="Copy all">Copy</button>
            <button id="logClear" class="btn small danger" title="Clear all">Clear</button>
          </div>
        </div>
        <div id="logBody" class="log-body" role="log" aria-live="polite"></div>
      `;

        this.root.appendChild(this.container);
        this.body = this.container.querySelector('#logBody') as HTMLElement;
        const clearBtn = this.container.querySelector('#logClear') as HTMLButtonElement;
        const copyBtn = this.container.querySelector('#logCopy') as HTMLButtonElement;
        this.actions = { clearBtn, copyBtn };
        clearBtn.addEventListener('click', () => this.onClear?.());
        copyBtn.addEventListener('click', () => this.onCopy?.());

        // 상단 스크롤 도달 시 이전 로그 요청
        this.container.addEventListener('scroll', () => {
          if (!this.loadingOlder && this.container && this.container.scrollTop <= 0) {
            this.loadingOlder = true;
            this.onLoadOlder?.();
          }
        });
      });
    } else if (!this.body) {
      this.body = this.container.querySelector('#logBody') as HTMLElement;
    }
  }

  /** "[HH:MM:SS(.mmm)]" 또는 "[HH:MM:SS]" 형태를 epoch(ms)로 파싱 (없으면 undefined) */
  private parseClockTs(line: string): number | undefined {
    const m = line.match(/^\[(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/);
    if (!m) return undefined;
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const ss = parseInt(m[3], 10);
    const ms = m[4] ? parseInt(m[4].padEnd(3, '0').slice(0, 3), 10) : 0;

    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, ss, ms);
    return d.getTime();
  }

  /** 세그먼트(0/1) 결정 및 갱신 */
  private pickSegment(line: string): 0 | 1 {
    const ts = this.parseClockTs(line) ?? Date.now();
    if (this.lastTs === undefined) {
      this.lastTs = ts;
      return this.seg;
    }
    if (ts - this.lastTs >= this.GAP_MS) {
      this.seg = this.seg === 0 ? 1 : 0;
      this.lastTs = ts;
    } else {
      // 정상 흐름이면 마지막 시각 갱신(타임스탬프가 역행하지 않는다는 가정)
      this.lastTs = ts;
    }
    return this.seg;
  }

  reset(lines?: string[]) {
    this.m('LogService.reset', () => {
      this.ensureContainer();
    // 세그먼트 상태 초기화
    this.lastTs = undefined;
    this.seg = 0;

    if (this.body) this.body.innerHTML = '';
    if (Array.isArray(lines)) lines.forEach((l) => this.append(l));
    // 초기화 후 스크롤 하단 고정
    if (this.container) this.container.scrollTop = this.container.scrollHeight;
    });
  }

  append(line: string) {
    this.m('LogService.append', () => {
      this.ensureContainer();

    // 세그먼트 토글 계산
    const seg = this.pickSegment(line);

    const div = document.createElement('div');
    div.className = `log-line seg${seg}`;

    // 에러 힌트는 기존처럼 표시(토글과 무관)
    if (/\[E\]/.test(line)) {
      div.style.color = '#ff6b6b';
    }

    div.textContent = line;
    (this.body as HTMLElement).appendChild(div);

    // 스크롤 맨 아래로
    this.container!.scrollTop = this.container!.scrollHeight;
    });
  }

  /** 오래된 라인들을 상단에 프리펜드(스크롤 점프 보정) */
  prepend(lines: string[]) {
    this.m('LogService.prepend', () => {
      this.ensureContainer();
    if (!this.body || !lines.length) {
      this.loadingOlder = false;
      return;
    }
    // 추가 전 현재 스크롤 높이 저장
    const before = this.container!.scrollHeight;
    // DocumentFragment로 배치 삽입
    const frag = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const seg = this.pickSegment(line);
      const div = document.createElement('div');
      div.className = `log-line seg${seg}`;
      if (/\[E\]/.test(line)) div.style.color = '#ff6b6b';
      div.textContent = line;
      frag.appendChild(div);
    }
    (this.body as HTMLElement).insertBefore(frag, this.body.firstChild);
    // 증가한 높이만큼 스크롤 유지(점프 방지)
    const after = this.container!.scrollHeight;
    const delta = after - before;
    this.container!.scrollTop = this.container!.scrollTop + delta;
    this.loadingOlder = false;
    });
  }

  get element() {
    return this.container;
  }
}
