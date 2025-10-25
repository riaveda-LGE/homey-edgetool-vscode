/* eslint-env browser */
/* global acquireVsCodeApi, Chart, ResizeObserver */
import { createUiLog, createUiMeasure } from '../shared/utils.js';

const vscode = acquireVsCodeApi();

// UI Logger for perf-monitor
const uiLog = createUiLog(vscode, 'ui.perfMonitor');
const measureUi = createUiMeasure(vscode);

// Global variables
let chart = null;
let exportHtml = '';
let resizeObserver = null;

// 차트 업데이트 스로틀링 (최대 10fps 수준)
let _updateScheduled = false;
let _lastDataForChart = null;
function scheduleChartUpdate(data) {
  _lastDataForChart = data;
  if (_updateScheduled) return;
  _updateScheduled = true;
  // 100ms 단위 스로틀
  globalThis.setTimeout(() => {
    try {
      updateChartNow(_lastDataForChart);
    } catch (e) {
      uiLog.error(`chart update failed: ${e}`);
    }
    _updateScheduled = false;
  }, 100);
}

// Apply VS Code theme variables
function applyTheme() {
  uiLog.debug('[debug] applyTheme: start');
  const bodyStyle = globalThis.getComputedStyle(globalThis.document.body);
  const bg = bodyStyle.getPropertyValue('--vscode-editor-background') || '#1e1e1e';
  const fg = bodyStyle.getPropertyValue('--vscode-editor-foreground') || '#cccccc';
  const accent = bodyStyle.getPropertyValue('--vscode-focusBorder') || '#007acc';

  globalThis.document.documentElement.style.setProperty('--vscode-bg', bg);
  globalThis.document.documentElement.style.setProperty('--vscode-fg', fg);
  globalThis.document.documentElement.style.setProperty('--vscode-accent', accent);

  // Update chart colors if chart exists
  if (chart) {
    try {
      // 차트 색은 고정값 유지(가독성)하되, 범례 텍스트 색은 테마에 맞춤
      chart.data.datasets[0].borderColor = '#00ff00';
      chart.data.datasets[0].backgroundColor = 'rgba(0, 255, 0, 0.2)';
      chart.data.datasets[1].borderColor = '#ffff00';
      chart.data.datasets[1].backgroundColor = 'rgba(255, 255, 0, 0.2)';
      chart.data.datasets[2].borderColor = '#ff0000';
      chart.data.datasets[2].backgroundColor = 'rgba(255, 0, 0, 0.2)';

      if (chart.options.plugins && chart.options.plugins.legend) {
        chart.options.plugins.legend.labels.color = fg;
      }
      chart.update();
    } catch (e) {
      uiLog.error(`Error updating chart theme: ${e}`);
    }
  }
  uiLog.debug('[debug] applyTheme: end');
}

function initChart() {
  uiLog.debug('[debug] initChart: start');
  // Wait for Chart.js to be loaded
  let retryCount = 0;
  const maxRetries = 50; // 5 seconds max

  const checkChart = () => {
    retryCount++;
    uiLog.debug(`Checking Chart.js (attempt ${retryCount})...`);

    if (typeof Chart !== 'undefined') {
      const chartContainer = globalThis.document.getElementById('chart');
      if (!chartContainer) {
        uiLog.error('Chart container element not found');
        return;
      }

      // Create canvas element dynamically (⚠️ 고정 폭/높이 설정 금지)
      const canvas = globalThis.document.createElement('canvas');
      canvas.id = 'performanceChart';
      // CSS가 100% 폭/높이를 맡도록 width/height 속성은 주지 않는다
      chartContainer.appendChild(canvas);

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        uiLog.error('Failed to get 2D context from canvas');
        return;
      }

      chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: [],
          datasets: [
            {
              label: 'CPU User (ms)',
              data: [],
              borderColor: '#00ff00',
              backgroundColor: 'rgba(0, 255, 0, 0.2)',
            },
            {
              label: 'CPU System (ms)',
              data: [],
              borderColor: '#ffff00',
              backgroundColor: 'rgba(255, 255, 0, 0.2)',
            },
            {
              label: 'Memory Used (MB)',
              data: [],
              borderColor: '#ff0000',
              backgroundColor: 'rgba(255, 0, 0, 0.2)',
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false, // 컨테이너 높이에 맞춰 늘어남 (#chart가 400px)
          scales: {
            x: {
              title: { display: true, text: 'Time' },
            },
            y: {
              title: { display: true, text: 'Value' },
            },
          },
          plugins: {
            legend: {
              labels: { color: 'var(--vscode-fg)' },
            },
          },
        },
      });

      // 컨테이너 사이즈가 변할 때(웹뷰 리사이즈 등) 차트 업데이트
      resizeObserver = new globalThis.ResizeObserver(() => {
        try {
          chart.resize();
        } catch {}
      });
      resizeObserver.observe(chartContainer);

      uiLog.debug('Chart initialized successfully');
    } else if (retryCount < maxRetries) {
      uiLog.debug(`Chart.js is not loaded yet, retrying... (${retryCount}/${maxRetries})`);
      globalThis.setTimeout(checkChart, 100);
    } else {
      uiLog.error('Failed to load Chart.js after maximum retries. Chart will not be available.');
      const chartContainer = globalThis.document.getElementById('chart');
      if (chartContainer) {
        chartContainer.innerHTML =
          '<div style="color: #ff6b6b; padding: 20px; border: 1px solid #ff6b6b; border-radius: 4px;">Chart.js library failed to load. Please check the console for details.</div>';
      }
    }
  };

  checkChart();
  uiLog.debug('[debug] initChart: end');
}

function updateChartNow(data) {
  uiLog.debug('[debug] updateChart: start');
  if (!chart) return;
  if (!Array.isArray(data)) return;
  const labels = data.map((d) => new Date(d.timestamp).toLocaleTimeString());
  const cpuUser = data.map((d) => d.cpu.user / 1000); // ms
  const cpuSystem = data.map((d) => d.cpu.system / 1000);
  const memory = data.map((d) => d.memory.heapUsed / 1024 / 1024); // MB

  // 안전하게 최대 포인트 수 제한(렌더 성능 보호)
  const MAX_POINTS = 1000;
  const trim = (arr) => (arr.length > MAX_POINTS ? arr.slice(-MAX_POINTS) : arr);

  chart.data.labels = labels;
  chart.data.datasets[0].data = trim(cpuUser);
  chart.data.datasets[1].data = trim(cpuSystem);
  chart.data.datasets[2].data = trim(memory);
  chart.update();
  uiLog.debug('[debug] updateChart: end');
}

function displayHtmlReport(html) {
  uiLog.debug('[debug] displayHtmlReport: start');
  const reportDiv = globalThis.document.getElementById('htmlReport');
  reportDiv.innerHTML = html;

  // Execute scripts in the inserted HTML
  const scripts = reportDiv.querySelectorAll('script');
  scripts.forEach((script) => {
    if (script.src) {
      const newScript = globalThis.document.createElement('script');
      newScript.src = script.src;
      globalThis.document.head.appendChild(newScript);
    } else {
      // ⚠️ inline script는 실행하지 않는다 (보안/안정성)
      uiLog.warn('Inline <script> was ignored in perf HTML report (inline execution is disabled).');
    }
  });
  uiLog.debug('[debug] displayHtmlReport: end');
}

// Initialize components
globalThis.document.addEventListener('DOMContentLoaded', function () {
  initChart();
  applyTheme();

  // HTML inline script content moved here
  let perfData = { cpu: [], memory: [], timings: [] };

  // 데이터 표시 업데이트
  function updateDataDisplay() {
    const dataStr = JSON.stringify(perfData, null, 2);
    const el = globalThis.document.getElementById('dataDisplay');
    if (el) el.textContent = dataStr;
  }

  // 데이터 업데이트 함수
  function updateDisplay(data) {
    // CPU
    if (data.cpuDelta) {
      perfData.cpu.push({
        user: data.cpuDelta.user,
        system: data.cpuDelta.system,
        timestamp: data.timestamp,
      });
      if (perfData.cpu.length > 10) perfData.cpu.shift();

      const latest = perfData.cpu[perfData.cpu.length - 1];
      const cpuValue = globalThis.document.getElementById('cpuValue');
      if (cpuValue) cpuValue.textContent = `${(latest.user + latest.system).toFixed(2)} ms`;

      const cpuList = globalThis.document.getElementById('cpuList');
      if (cpuList)
        cpuList.innerHTML = perfData.cpu
          .map(
            (entry) =>
              `<div class="perf-entry">
            ${new Date(entry.timestamp).toLocaleTimeString()}:
            User ${entry.user.toFixed(2)}ms, System ${entry.system.toFixed(2)}ms
          </div>`,
          )
          .join('');
    }

    // 메모리
    if (data.memDelta) {
      perfData.memory.push({
        heapUsed: data.memDelta.heapUsed,
        rss: data.memDelta.rss,
        timestamp: data.timestamp,
      });
      if (perfData.memory.length > 10) perfData.memory.shift();

      const latest = perfData.memory[perfData.memory.length - 1];
      const memValue = globalThis.document.getElementById('memValue');
      if (memValue) memValue.textContent = `${latest.heapUsed.toFixed(2)} MB`;

      const memList = globalThis.document.getElementById('memList');
      if (memList)
        memList.innerHTML = perfData.memory
          .map(
            (entry) =>
              `<div class="perf-entry">
            ${new Date(entry.timestamp).toLocaleTimeString()}:
            Heap ${entry.heapUsed.toFixed(2)}MB, RSS ${entry.rss.toFixed(2)}MB
          </div>`,
          )
          .join('');
    }

    // 타이밍
    perfData.timings.push({
      operation: data.operation,
      duration: data.duration,
      timestamp: data.timestamp,
    });
    if (perfData.timings.length > 20) perfData.timings.shift();

    const timingList = globalThis.document.getElementById('timingList');
    if (timingList)
      timingList.innerHTML = perfData.timings
        .map(
          (entry) =>
            `<div class="perf-entry">
          ${new Date(entry.timestamp).toLocaleTimeString()} -
          ${entry.operation}: ${data.duration?.toFixed(2)}ms
        </div>`,
        )
        .join('');

    // 상태
    const status = globalThis.document.getElementById('status');
    if (status)
      status.textContent = `Last update: ${new Date(data.timestamp).toLocaleTimeString()} - ${data.operation}`;

    updateDataDisplay();
  }

  // Handle messages from extension
  globalThis.addEventListener('message', (event) => {
    const message = event.data;
    if (message.v !== 1) return;

    switch (message.type) {
      case 'perf.updateData':
        // 전체 샘플로 차트 갱신(스로틀)
        scheduleChartUpdate(message.payload.data);
        break;
      case 'perf.updateDelta':
        // 증분 정보(패널의 요약 텍스트들만 업데이트)
        updateDisplay(message.payload);
        break;
      case 'perf.captureStarted':
        {
          const btn = globalThis.document.getElementById('captureBtn');
          if (btn) btn.textContent = 'Stop Capture';
        }
        break;
      case 'perf.captureStopped':
        {
          const btn = globalThis.document.getElementById('captureBtn');
          if (btn) btn.textContent = 'Start Capture';
        }
        if (message.payload.htmlReport) {
          displayHtmlReport(message.payload.htmlReport);
        }
        if (message.payload.exportHtml) {
          exportHtml = message.payload.exportHtml;
        }
        break;
      case 'vscode.themeChanged':
        // 확장 쪽에서 테마 변경 알림을 보낼 수 있게 열어둠
        applyTheme();
        break;
      // flame graph messages removed
    }
  });

  // Buttons
  const captureBtn = globalThis.document.getElementById('captureBtn');
  if (captureBtn)
    captureBtn.addEventListener('click', function (e) {
      const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
      if (btn && btn.textContent === 'Start Capture') {
        vscode.postMessage({ v: 1, type: 'perf.startCapture' });
      } else {
        vscode.postMessage({ v: 1, type: 'perf.stopCapture' });
      }
    });

  const exportBtn = globalThis.document.getElementById('exportBtn');
  if (exportBtn)
    exportBtn.addEventListener('click', function () {
      measureUi('ui.exportJson', () => vscode.postMessage({ v: 1, type: 'perf.exportJson' }));
    });

  const exportHtmlBtn = globalThis.document.getElementById('exportHtmlBtn');
  if (exportHtmlBtn)
    exportHtmlBtn.addEventListener('click', function () {
      measureUi('ui.exportHtml', () =>
        vscode.postMessage({ v: 1, type: 'perf.exportHtmlReport', payload: { html: exportHtml } }),
      );
    });

  const copyDataBtn = globalThis.document.getElementById('copyDataBtn');
  if (copyDataBtn)
    copyDataBtn.addEventListener('click', async () => {
      const dataStr = JSON.stringify(perfData, null, 2);
      try {
        await globalThis.navigator.clipboard.writeText(dataStr);
        globalThis.alert('Performance data copied to clipboard!');
      } catch (err) {
        const textArea = globalThis.document.createElement('textarea');
        textArea.value = dataStr;
        globalThis.document.body.appendChild(textArea);
        textArea.select();
        textArea.focus();
        globalThis.document.execCommand('selectall');
        globalThis.document.execCommand('copy');
        globalThis.document.body.removeChild(textArea);
        globalThis.alert('Performance data copied to clipboard!');
      }
    });

  const exportDataBtn = globalThis.document.getElementById('exportDataBtn');
  if (exportDataBtn)
    exportDataBtn.addEventListener('click', () => {
      const dataStr = JSON.stringify(perfData, null, 2);
      const blob = new globalThis.Blob([dataStr], { type: 'application/json' });
      const url = globalThis.URL.createObjectURL(blob);
      const a = globalThis.document.createElement('a');
      a.href = url;
      a.download =
        'homey-perf-data-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.json';
      globalThis.document.body.appendChild(a);
      a.click();
      globalThis.document.body.removeChild(a);
      globalThis.URL.revokeObjectURL(url);
    });

  // Ready
  vscode.postMessage({ v: 1, type: 'perf.ready', payload: {} });

  // cleanup (웹뷰 닫힘/리로드)
  globalThis.addEventListener('beforeunload', () => {
    try {
      if (resizeObserver) resizeObserver.disconnect();
    } catch {}
    try {
      if (chart) chart.destroy();
    } catch {}
  });
});
