export class LogService {
  private container: HTMLElement | null = null;
  private body: HTMLElement | null = null;

  // ── 세그먼트 토글 상태 (10초 간격) ──────────────────────────────
  private lastTs: number | undefined;
  private seg: 0 | 1 = 0;
  private readonly GAP_MS = 10_000; // 30초
  // ───────────────────────────────────────────────────────────────

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

  /** "[HH:MM:SS(.mmm)]" 또는 "[HH:MM:SS]" 형태를 epoch(ms)로 파싱 (없으면 undefined) */
  private parseClockTs(line: string): number | undefined {
    const m = line.match(/^\[(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/);
    if (!m) return undefined;
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const ss = parseInt(m[3], 10);
    const ms = m[4] ? parseInt(m[4].padEnd(3, '0').slice(0, 3), 10) : 0;

    const now = new Date();
    const d = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hh, mm, ss, ms
    );
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
    this.ensureContainer();
    // 세그먼트 상태 초기화
    this.lastTs = undefined;
    this.seg = 0;

    if (this.body) this.body.innerHTML = '';
    if (Array.isArray(lines)) lines.forEach((l) => this.append(l));
  }

  append(line: string) {
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
  }

  get element() { return this.container; }
}
