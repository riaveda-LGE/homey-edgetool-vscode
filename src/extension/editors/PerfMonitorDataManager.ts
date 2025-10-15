// === src/extension/editors/PerfMonitorDataManager.ts ===
import { PERF_DATA_MAX } from '../../shared/const.js';

export class PerfMonitorDataManager {
  private _perfMode = false;
  private _perfData: any[] = [];

  setPerfMode(enabled: boolean): void {
    this._perfMode = enabled;
  }

  isPerfMode(): boolean {
    return this._perfMode;
  }

  addPerfData(data: any): void {
    if (!this._perfMode) return;

    this._perfData.push(data);
    if (this._perfData.length > PERF_DATA_MAX) {
      this._perfData.shift();
    }
  }

  getPerfData(): any[] {
    return [...this._perfData];
  }

  clearPerfData(): void {
    this._perfData = [];
  }
}
