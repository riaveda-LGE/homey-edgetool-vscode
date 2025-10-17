import { createUiLog } from '../shared/utils.js';

const vscode = acquireVsCodeApi();

// UI Logger for perf-monitor
const uiLog = createUiLog(vscode, 'ui.perfMonitor');

// Global variables
let chart = null;
let exportHtml = '';

// Apply VS Code theme variables
function applyTheme() {
  const bodyStyle = getComputedStyle(document.body);
  const bg = bodyStyle.getPropertyValue('--vscode-editor-background') || '#1e1e1e';
  const fg = bodyStyle.getPropertyValue('--vscode-editor-foreground') || '#cccccc';
  const accent = bodyStyle.getPropertyValue('--vscode-focusBorder') || '#007acc';

  document.documentElement.style.setProperty('--vscode-bg', bg);
  document.documentElement.style.setProperty('--vscode-fg', fg);
  document.documentElement.style.setProperty('--vscode-accent', accent);

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
}

function initChart() {
  // Wait for Chart.js to be loaded
  let retryCount = 0;
  const maxRetries = 50; // 5 seconds max

  const checkChart = () => {
    retryCount++;
    uiLog.info(`Checking Chart.js (attempt ${retryCount})...`);
    uiLog.info(`Chart: ${typeof Chart}, ${Chart ? 'loaded' : 'not loaded'}`);

    if (typeof Chart !== 'undefined') {
      const chartContainer = document.getElementById('chart');
      if (!chartContainer) {
        uiLog.error('Chart container element not found');
        return;
      }

      // Create canvas element dynamically (⚠️ 고정 폭/높이 설정 금지)
      const canvas = document.createElement('canvas');
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
      const ro = new ResizeObserver(() => {
        try { chart.resize(); } catch {}
      });
      ro.observe(chartContainer);

      uiLog.info('Chart initialized successfully');
    } else if (retryCount < maxRetries) {
      uiLog.warn(`Chart.js is not loaded yet, retrying... (${retryCount}/${maxRetries})`);
      setTimeout(checkChart, 100);
    } else {
      uiLog.error('Failed to load Chart.js after maximum retries. Chart will not be available.');
      const chartContainer = document.getElementById('chart');
      if (chartContainer) {
        chartContainer.innerHTML =
          '<div style="color: #ff6b6b; padding: 20px; border: 1px solid #ff6b6b; border-radius: 4px;">Chart.js library failed to load. Please check the console for details.</div>';
      }
    }
  };

  checkChart();
}

function updateChart(data) {
  if (!chart) return;
  const labels = data.map(d => new Date(d.timestamp).toLocaleTimeString());
  const cpuUser = data.map(d => d.cpu.user / 1000); // ms
  const cpuSystem = data.map(d => d.cpu.system / 1000);
  const memory = data.map(d => d.memory.heapUsed / 1024 / 1024); // MB

  chart.data.labels = labels;
  chart.data.datasets[0].data = cpuUser;
  chart.data.datasets[1].data = cpuSystem;
  chart.data.datasets[2].data = memory;
  chart.update();
}

function displayHtmlReport(html) {
  const reportDiv = document.getElementById('htmlReport');
  reportDiv.innerHTML = html;

  // Execute scripts in the inserted HTML
  const scripts = reportDiv.querySelectorAll('script');
  scripts.forEach(script => {
    if (script.src) {
      const newScript = document.createElement('script');
      newScript.src = script.src;
      document.head.appendChild(newScript);
    } else {
      try {
        eval(script.textContent);
      } catch (error) {
        uiLog.error(`Error executing inline script in exported report: ${error}`);
      }
    }
  });
}

function measureFunction(name, fn) {
  const start = performance.now();
  const result = fn();
  const duration = performance.now() - start;
  vscode.postMessage({ v: 1, type: 'perfMeasure', payload: { name, duration } });
  return result;
}

// Initialize components
document.addEventListener('DOMContentLoaded', function() {
  initChart();
  applyTheme();

  // HTML inline script content moved here
  let perfData = { cpu: [], memory: [], timings: [] };

  // 데이터 표시 업데이트
  function updateDataDisplay() {
    const dataStr = JSON.stringify(perfData, null, 2);
    document.getElementById('dataDisplay').textContent = dataStr;
  }

  // 데이터 업데이트 함수
  function updateDisplay(data) {
    // CPU
    if (data.cpuDelta) {
      perfData.cpu.push({
        user: data.cpuDelta.user,
        system: data.cpuDelta.system,
        timestamp: data.timestamp
      });
      if (perfData.cpu.length > 10) perfData.cpu.shift();

      const latest = perfData.cpu[perfData.cpu.length - 1];
      document.getElementById('cpuValue').textContent =
        `${(latest.user + latest.system).toFixed(2)} ms`;

      document.getElementById('cpuList').innerHTML = perfData.cpu
        .map(entry =>
          `<div class="perf-entry">
            ${new Date(entry.timestamp).toLocaleTimeString()}:
            User ${entry.user.toFixed(2)}ms, System ${entry.system.toFixed(2)}ms
          </div>`
        ).join('');
    }

    // 메모리
    if (data.memDelta) {
      perfData.memory.push({
        heapUsed: data.memDelta.heapUsed,
        rss: data.memDelta.rss,
        timestamp: data.timestamp
      });
      if (perfData.memory.length > 10) perfData.memory.shift();

      const latest = perfData.memory[perfData.memory.length - 1];
      document.getElementById('memValue').textContent =
        `${latest.heapUsed.toFixed(2)} MB`;

      document.getElementById('memList').innerHTML = perfData.memory
        .map(entry =>
          `<div class="perf-entry">
            ${new Date(entry.timestamp).toLocaleTimeString()}:
            Heap ${entry.heapUsed.toFixed(2)}MB, RSS ${entry.rss.toFixed(2)}MB
          </div>`
        ).join('');
    }

    // 타이밍
    perfData.timings.push({
      operation: data.operation,
      duration: data.duration,
      timestamp: data.timestamp
    });
    if (perfData.timings.length > 20) perfData.timings.shift();

    document.getElementById('timingList').innerHTML = perfData.timings
      .map(entry =>
        `<div class="perf-entry">
          ${new Date(entry.timestamp).toLocaleTimeString()} -
          ${entry.operation}: ${data.duration?.toFixed(2)}ms
        </div>`
      ).join('');

    // 상태
    document.getElementById('status').textContent =
      `Last update: ${new Date(data.timestamp).toLocaleTimeString()} - ${data.operation}`;

    updateDataDisplay();
  }

  // Handle messages from extension
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.v !== 1) return;

    switch (message.type) {
      case 'perf.updateData':
        updateChart(message.payload.data);
        break;
      case 'perf.captureStarted':
        document.getElementById('captureBtn').textContent = 'Stop Capture';
        break;
      case 'perf.captureStopped':
        document.getElementById('captureBtn').textContent = 'Start Capture';
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
  document.getElementById('captureBtn').addEventListener('click', function() {
    const btn = this;
    if (btn.textContent === 'Start Capture') {
      vscode.postMessage({ v: 1, type: 'perf.startCapture' });
    } else {
      vscode.postMessage({ v: 1, type: 'perf.stopCapture' });
    }
  });

  document.getElementById('exportBtn').addEventListener('click', function() {
    vscode.postMessage({ v: 1, type: 'perf.exportJson' });
  });

  document.getElementById('exportHtmlBtn').addEventListener('click', function() {
    vscode.postMessage({ v: 1, type: 'perf.exportHtmlReport', payload: { html: exportHtml } });
  });

  document.getElementById('copyDataBtn').addEventListener('click', async () => {
    const dataStr = JSON.stringify(perfData, null, 2);
    try {
      await navigator.clipboard.writeText(dataStr);
      alert('Performance data copied to clipboard!');
    } catch (err) {
      const textArea = document.createElement('textarea');
      textArea.value = dataStr;
      document.body.appendChild(textArea);
      textArea.select();
      textArea.focus();
      document.execCommand('selectall');
      document.execCommand('copy');
      document.body.removeChild(textArea);
      alert('Performance data copied to clipboard!');
    }
  });

  document.getElementById('exportDataBtn').addEventListener('click', () => {
    const dataStr = JSON.stringify(perfData, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'homey-perf-data-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // Ready
  vscode.postMessage({ v: 1, type: 'perf.ready', payload: {} });
});
