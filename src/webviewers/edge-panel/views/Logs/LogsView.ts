import { LogService } from '../../services/LogService.js';

export class LogsView {
  constructor(private logs: LogService) {}
  reset(lines?: string[]) {
    this.logs.reset(lines);
  }
  append(line: string) {
    this.logs.append(line);
  }
  prepend(lines: string[]) {
    this.logs.prepend(lines);
  }
  get element() {
    return this.logs.element;
  }
}
