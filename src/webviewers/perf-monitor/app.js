/* eslint-env browser */
/* global acquireVsCodeApi, Chart, ResizeObserver */
import { createUiLog } from '../shared/utils.js';

const vscode = acquireVsCodeApi();

// UI Logger for perf-monitor
const uiLog = createUiLog(vscode, 'ui.perfMonitor');

// Global variables
let chart = null;
let exportHtml = '';

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
      chart.data.datasets[0].borderColor = '#00ff00'; // CPU User
      chart.data.datasets[0].backgroundColor = 'rgba(0, 255, 0, 0.2)';
      chart.data.datasets[1].borderColor = '#ffff00'; // CPU System
      chart.data.datasets[1].backgroundColor = 'rgba(255, 255, 0, 0.2)';
      chart.data.datasets[2].borderColor = '#ff0000'; // Memory
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
    uiLog.info(`Checking Chart.js (attempt ${retryCount})...`);
    uiLog.info(`Chart: ${typeof Chart}, ${Chart ? 'loaded' : 'not loaded'}`);

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
      const ro = new globalThis.ResizeObserver(() => {
        try {
          chart.resize();
        } catch {}
      });
      ro.observe(chartContainer);

      uiLog.info('Chart initialized successfully');
    } else if (retryCount < maxRetries) {
      uiLog.warn(`Chart.js is not loaded yet, retrying... (${retryCount}/${maxRetries})`);
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

function updateChart(data) {
  uiLog.debug('[debug] updateChart: start');
  if (!chart) return;
  const labels = data.map((d) => new Date(d.timestamp).toLocaleTimeString());
  const cpuUser = data.map((d) => d.cpu.user / 1000); // ms
  const cpuSystem = data.map((d) => d.cpu.system / 1000);
  const memory = data.map((d) => d.memory.heapUsed / 1024 / 1024); // MB

  chart.data.labels = labels;
  chart.data.datasets[0].data = cpuUser;
  chart.data.datasets[1].data = cpuSystem;
  chart.data.datasets[2].data = memory;
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
      try {
        eval(script.textContent);
      } catch (error) {
        uiLog.error(`Error executing inline script in exported report: ${error}`);
      }
    }
  });
  uiLog.debug('[debug] displayHtmlReport: end');
}

function measureFunction(name, fn) {
  uiLog.debug('[debug] measureFunction: start');
  const start = globalThis.performance.now();
  const result = fn();
  const duration = globalThis.performance.now() - start;
  vscode.postMessage({ v: 1, type: 'perfMeasure', payload: { name, duration } });
  uiLog.debug('[debug] measureFunction: end');
  return result;
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
    globalThis.document.getElementById('dataDisplay').textContent = dataStr;
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
      globalThis.document.getElementById('cpuValue').textContent =
        `${(latest.user + latest.system).toFixed(2)} ms`;

      globalThis.document.getElementById('cpuList').innerHTML = perfData.cpu
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
      globalThis.document.getElementById('memValue').textContent =
        `${latest.heapUsed.toFixed(2)} MB`;

      globalThis.document.getElementById('memList').innerHTML = perfData.memory
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

    globalThis.document.getElementById('timingList').innerHTML = perfData.timings
      .map(
        (entry) =>
          `<div class="perf-entry">
          ${new Date(entry.timestamp).toLocaleTimeString()} -
          ${entry.operation}: ${data.duration?.toFixed(2)}ms
        </div>`,
      )
      .join('');

    // 상태
    globalThis.document.getElementById('status').textContent =
      `Last update: ${new Date(data.timestamp).toLocaleTimeString()} - ${data.operation}`;

    updateDataDisplay();
  }

  // Handle messages from extension
  globalThis.addEventListener('message', (event) => {
    const message = event.data;
    if (message.v !== 1) return;

    switch (message.type) {
      case 'perf.updateData':
        updateChart(message.payload.data);
        break;
      case 'perf.captureStarted':
        globalThis.document.getElementById('captureBtn').textContent = 'Stop Capture';
        break;
      case 'perf.captureStopped':
        globalThis.document.getElementById('captureBtn').textContent = 'Start Capture';
        if (message.payload.htmlReport) {
          displayHtmlReport(message.payload.htmlReport);
        }
        if (message.payload.exportHtml) {
          exportHtml = message.payload.exportHtml;
        }
        break;
      // flame graph messages removed
    }
  });

  // Buttons
  globalThis.document.getElementById('captureBtn').addEventListener('click', function (e) {
    const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
    if (btn && btn.textContent === 'Start Capture') {
      vscode.postMessage({ v: 1, type: 'perf.startCapture' });
    } else {
      vscode.postMessage({ v: 1, type: 'perf.stopCapture' });
    }
  });

  globalThis.document.getElementById('exportBtn').addEventListener('click', function () {
    vscode.postMessage({ v: 1, type: 'perf.exportJson' });
  });

  globalThis.document.getElementById('exportHtmlBtn').addEventListener('click', function () {
    vscode.postMessage({ v: 1, type: 'perf.exportHtmlReport', payload: { html: exportHtml } });
  });

  globalThis.document.getElementById('copyDataBtn').addEventListener('click', async () => {
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

  globalThis.document.getElementById('exportDataBtn').addEventListener('click', () => {
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
});
