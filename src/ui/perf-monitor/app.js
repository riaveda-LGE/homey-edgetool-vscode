// === src/ui/perf-monitor/app.js ===
const vscode = acquireVsCodeApi();

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
      // Use bright colors for dark theme visibility
      chart.data.datasets[0].borderColor = '#00ff00'; // Green for CPU User
      chart.data.datasets[0].backgroundColor = 'rgba(0, 255, 0, 0.2)';
      chart.data.datasets[1].borderColor = '#ffff00'; // Yellow for CPU System
      chart.data.datasets[1].backgroundColor = 'rgba(255, 255, 0, 0.2)';
      chart.data.datasets[2].borderColor = '#ff0000'; // Red for Memory
      chart.data.datasets[2].backgroundColor = 'rgba(255, 0, 0, 0.2)';
      // Note: scales.title.color is not supported in Chart.js 4.x
      // chart.options.scales.x.title.color = fg;
      // chart.options.scales.x.ticks.color = fg;
      // chart.options.scales.y.title.color = fg;
      // chart.options.scales.y.ticks.color = fg;
      if (chart.options.plugins && chart.options.plugins.legend) {
        chart.options.plugins.legend.labels.color = fg;
      }
      chart.update();
    } catch (e) {
      console.error('Error updating chart theme:', e);
    }
  }
}

function initChart() {
  // Wait for Chart.js to be loaded
  let retryCount = 0;
  const maxRetries = 50; // 5 seconds max

  const checkChart = () => {
    retryCount++;
    console.log(`Checking Chart.js (attempt ${retryCount})...`);
    console.log('Chart:', typeof Chart, Chart ? 'loaded' : 'not loaded');

    if (typeof Chart !== 'undefined') {
      const chartContainer = document.getElementById('chart');
      if (!chartContainer) {
        console.error('Chart container element not found');
        return;
      }

      // Create canvas element dynamically
      const canvas = document.createElement('canvas');
      canvas.id = 'performanceChart';
      canvas.width = 800;
      canvas.height = 400;
      chartContainer.appendChild(canvas);

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        console.error('Failed to get 2D context from canvas');
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
              borderColor: '#00ff00', // Green
              backgroundColor: 'rgba(0, 255, 0, 0.2)',
            },
            {
              label: 'CPU System (ms)',
              data: [],
              borderColor: '#ffff00', // Yellow
              backgroundColor: 'rgba(255, 255, 0, 0.2)',
            },
            {
              label: 'Memory Used (MB)',
              data: [],
              borderColor: '#ff0000', // Red
              backgroundColor: 'rgba(255, 0, 0, 0.2)',
            },
          ],
        },
        options: {
          scales: {
            x: {
              title: {
                display: true,
                text: 'Time',
              },
            },
            y: {
              title: {
                display: true,
                text: 'Value',
              },
            },
          },
          plugins: {
            legend: {
              labels: {
                color: 'var(--vscode-fg)',
              },
            },
          },
        },
      });
      console.log('Chart initialized successfully');
    } else if (retryCount < maxRetries) {
      console.warn(`Chart.js is not loaded yet, retrying... (${retryCount}/${maxRetries})`);
      setTimeout(checkChart, 100);
    } else {
      console.error('Failed to load Chart.js after maximum retries. Chart will not be available.');
      // Create a fallback message
      const chartContainer = document.getElementById('chart');
      if (chartContainer) {
        chartContainer.innerHTML = '<div style="color: #ff6b6b; padding: 20px; border: 1px solid #ff6b6b; border-radius: 4px;">Chart.js library failed to load. Please check the console for details.</div>';
      }
    }
  };

  checkChart();
}function updateChart(data) {
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
      // External script - create new script element
      const newScript = document.createElement('script');
      newScript.src = script.src;
      document.head.appendChild(newScript);
    } else {
      // Inline script - execute directly
      try {
        eval(script.textContent);
      } catch (error) {
        console.error('Error executing inline script in exported report:', error);
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
});

// Button event listeners
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
