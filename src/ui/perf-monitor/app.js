// === src/ui/perf-monitor/app.js ===
const vscode = acquireVsCodeApi();

let chart;

function initChart() {
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
          borderColor: 'rgba(75, 192, 192, 1)',
          backgroundColor: 'rgba(75, 192, 192, 0.2)',
        },
        {
          label: 'CPU System (ms)',
          data: [],
          borderColor: 'rgba(153, 102, 255, 1)',
          backgroundColor: 'rgba(153, 102, 255, 0.2)',
        },
        {
          label: 'Memory Used (MB)',
          data: [],
          borderColor: 'rgba(255, 159, 64, 1)',
          backgroundColor: 'rgba(255, 159, 64, 0.2)',
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
    },
  });
}

function updateChart(data) {
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
}

function measureFunction(name, fn) {
  const start = performance.now();
  const result = fn();
  const duration = performance.now() - start;
  vscode.postMessage({ type: 'perfMeasure', name, duration });
  return result;
}

document.getElementById('captureBtn').addEventListener('click', () => {
  const button = document.getElementById('captureBtn');
  const isCapturing = button.textContent === 'Stop Capture';

  measureFunction(isCapturing ? 'stopCapture' : 'startCapture', () => {
    if (isCapturing) {
      console.log('Sending stopCapture message to extension');
      vscode.postMessage({ type: 'stopCapture' });
    } else {
      console.log('Sending startCapture message to extension');
      vscode.postMessage({ type: 'startCapture' });
    }
  });
});

document.getElementById('exportBtn').addEventListener('click', () => {
  measureFunction('exportJson', () => {
    vscode.postMessage({ type: 'exportJson' });
  });
});

document.getElementById('exportHtmlBtn').addEventListener('click', () => {
  const html = document.getElementById('htmlReport').innerHTML;
  measureFunction('exportHtmlReport', () => {
    vscode.postMessage({ type: 'exportHtmlReport', html });
  });
});

window.addEventListener('message', event => {
  console.log('Received message:', event.data);
  const message = event.data;
  switch (message.type) {
    case 'updateData':
      updateChart(message.data);
      break;
    case 'captureStarted':
      console.log('Processing captureStarted message');
      document.getElementById('captureBtn').textContent = 'Stop Capture';
      console.log('Button text changed to: Stop Capture');
      break;
    case 'captureStopped':
      console.log('Processing captureStopped message');
      document.getElementById('captureBtn').textContent = 'Start Capture';
      console.log('Button text changed to: Start Capture');
      if (message.htmlReport) {
        displayHtmlReport(message.htmlReport);
      }
      break;
  }
});

initChart();
