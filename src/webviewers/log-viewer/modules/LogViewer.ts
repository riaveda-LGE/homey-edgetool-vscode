export class LogViewer {
  constructor(private el: HTMLElement) {}
  append(line: string) {
    const div = document.createElement('div');
    div.textContent = line;
    this.el.appendChild(div);
    this.el.scrollTop = this.el.scrollHeight;
  }
  reset(lines: string[]) {
    this.el.innerHTML = '';
    for (const l of lines) this.append(l);
  }
}
