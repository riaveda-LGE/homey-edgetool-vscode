// === src/extension/editors/PerfMonitorCaptureManager.ts ===
import type { H2W } from '@ipc/messages';
import * as vscode from 'vscode';

import { getLogger } from '../../core/logging/extension-logger.js';
import { globalProfiler, PerformanceProfiler, enableAutoFsIOMeasure } from '../../core/logging/perf.js';
import { PERF_UPDATE_INTERVAL_MS } from '../../shared/const.js';
import type { IPerfMonitorCaptureManager, PerfData } from './IPerfMonitorPanelComponents.js';
import { PerfMonitorHtmlGenerator } from './PerfMonitorHtmlGenerator.js';

export class PerfMonitorCaptureManager implements IPerfMonitorCaptureManager {
  private _profiler = globalProfiler;
  private _captureInterval?: NodeJS.Timeout;
  private _captureData: PerfData[] = [];
  private _isCapturing = false;
  private _webviewPerfData: Array<{ name: string; duration: number }> = [];
  private _panel?: vscode.WebviewPanel;
  private _lastCpu?: NodeJS.CpuUsage;
  private _htmlGen: PerfMonitorHtmlGenerator;

  constructor(panel: vscode.WebviewPanel, htmlGenerator: PerfMonitorHtmlGenerator) {
    this._panel = panel;
    this._htmlGen = htmlGenerator;
  }

  get isCapturing(): boolean {
    return this._isCapturing;
  }

  startCapture(): void {
    const log = getLogger('perfMonitor');
    log.info('PerfMonitorCaptureManager.startCapture called');
    // I/O 자동 계측 활성화 (1회성)
    enableAutoFsIOMeasure();
    this._profiler.enable();
    this._profiler.startCapture();
    this._isCapturing = true;
    this._webviewPerfData = [];
    this._captureData = [];
    // 기준 CPU 스냅샷 (delta 계산용)
    this._lastCpu = process.cpuUsage();
    log.info('Capture started, sending captureStarted message to webview');
    if (this._panel) {
      this._panel.webview.postMessage({
        v: 1,
        type: 'perf.captureStarted',
        payload: {},
      } as H2W);
      log.info('captureStarted message sent');
    } else {
      log.warn('No panel available to send message');
    }

    this._captureInterval = setInterval(() => {
      if (this._isCapturing && this._panel) {
        // CPU delta (µs) 계산
        const delta = this._lastCpu ? process.cpuUsage(this._lastCpu) : process.cpuUsage();
        this._lastCpu = process.cpuUsage();
        const data: PerfData = {
          timestamp: new Date().toISOString(),
          // 차트는 delta를 ms로 환산해서 그리므로 여기엔 µs delta를 담아 보낸다
          cpu: { user: delta.user, system: delta.system } as NodeJS.CpuUsage,
          memory: process.memoryUsage(),
        };
        this._captureData.push(data);
        if (this._captureData.length > 100) {
          this._captureData.shift();
        }
        this._panel.webview.postMessage({
          v: 1,
          type: 'perf.updateData',
          payload: { data: this._captureData },
        } as H2W);
      }
    }, PERF_UPDATE_INTERVAL_MS);
  }

  stopCapture(): void {
    const result = this._profiler.stopCapture();
    this._isCapturing = false;
    this._profiler.disable();

    if (this._captureInterval) {
      clearInterval(this._captureInterval);
      this._captureInterval = undefined;
    }

    const combinedFunctionCalls = [
      ...(result.functionCalls || []),
      ...this._webviewPerfData.map((d: any) => ({ name: d.name, start: 0, duration: d.duration })),
    ];
    const combinedResult = { ...result, functionCalls: combinedFunctionCalls };

    if (this._panel) {
      const webviewHtml = this._htmlGen.generateHtmlReport(combinedResult, true);
      const exportHtml = this._htmlGen.generateHtmlReport(combinedResult, false);
      this._panel.webview.postMessage({
        v: 1,
        type: 'perf.captureStopped',
        payload: { result: combinedResult, htmlReport: webviewHtml, exportHtml },
      } as H2W);
    }
  }

  addWebviewPerfData(name: string, duration: number): void {
    this._webviewPerfData.push({ name, duration });
  }

  dispose(): void {
    if (this._captureInterval) {
      clearInterval(this._captureInterval);
      this._captureInterval = undefined;
    }
  }
}
