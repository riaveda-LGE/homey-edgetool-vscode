// === src/extension/editors/PerfMonitorMessageHandler.ts ===
import { getLogger } from '../../core/logging/extension-logger.js';
import type { W2H } from '../messaging/messageTypes.js';
import type { IPerfMonitorMessageHandler, IPerfMonitorCaptureManager, IPerfMonitorExportManager } from './IPerfMonitorPanelComponents.js';

export class PerfMonitorMessageHandler implements IPerfMonitorMessageHandler {
  private _captureManager: IPerfMonitorCaptureManager;
  private _exportManager: IPerfMonitorExportManager;

  constructor(
    captureManager: IPerfMonitorCaptureManager,
    exportManager: IPerfMonitorExportManager
  ) {
    this._captureManager = captureManager;
    this._exportManager = exportManager;
  }

  handleMessage(message: W2H): void {
    const log = getLogger('perfMonitor');
    switch (message.type) {
      case 'ui.log':
        if (message.v === 1 && message.payload) {
          const lvl = String(message.payload.level ?? 'info') as 'debug' | 'info' | 'warn' | 'error';
          const text = String(message.payload.text ?? '');
          const src = String(message.payload.source ?? 'ui.perfMonitor');
          const lg = getLogger(src);
          (lg[lvl] ?? lg.info).call(lg, text);
        }
        break;
      case 'perf.exportJson':
        this._exportManager.exportJson();
        break;
      case 'perf.startCapture':
        this._captureManager.startCapture();
        break;
      case 'perf.stopCapture':
        this._captureManager.stopCapture();
        break;
      case 'perfMeasure':
        this._captureManager.addWebviewPerfData(message.payload.name, message.payload.duration);
        break;
      case 'perf.exportHtmlReport':
        this._exportManager.exportDisplayedHtml(message.payload.html);
        break;
    }
  }
}
