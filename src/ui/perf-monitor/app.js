// === src/ui/perf-monitor/app.js ===
const vscode = acquireVsCodeApi();

// Global variables
let chart = null;
let flameGraphReady = false;
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

function initFlameGraph() {
  // Check if D3 is loaded
  let retryCount = 0;
  const maxRetries = 50; // 5 seconds max

  const checkD3 = () => {
    retryCount++;
    console.log(`Checking D3 (attempt ${retryCount})...`);
    console.log('d3:', typeof d3, d3 ? 'loaded' : 'not loaded');

    if (typeof d3 !== 'undefined') {
      console.log('D3 library loaded successfully, initializing custom flame graph');
      flameGraphReady = true;
    } else if (retryCount < maxRetries) {
      console.warn(`D3 library is not loaded yet, retrying... (${retryCount}/${maxRetries})`);
      setTimeout(checkD3, 100);
    } else {
      console.error('Failed to load D3 library after maximum retries. Flame Graph will not be available.');
    }
  };

  checkD3();
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
        console.error('Error executing inline script:', error);
      }
    }
  });

  // Check if flame graph container exists and render flame graph
  const flameGraphContainer = reportDiv.querySelector('#flameGraph');
  if (flameGraphContainer && flameGraphReady) {
    // Get performance data from the extension
    vscode.postMessage({ v: 1, type: 'perf.getFlameGraphData' });
  }
}// Custom Flame Graph implementation using D3 v6 with advanced features
function renderFlameGraph(data, containerId) {
  console.log('renderFlameGraph called with data:', data, 'containerId:', containerId);
  if (!flameGraphReady || !d3) {
    console.error('Flame Graph not ready or D3 not loaded');
    return;
  }

  const container = document.getElementById(containerId);
  if (!container) {
    console.error('Flame Graph container not found:', containerId);
    return;
  }

  // Clear previous content
  container.innerHTML = '';

  // Set up dimensions
  const width = 800;
  const height = 400;
  const margin = { top: 20, right: 20, bottom: 20, left: 20 };

  // Create SVG
  const svg = d3.select(container)
    .append('svg')
    .attr('width', width)
    .attr('height', height)
    .style('border', '1px solid #ccc');

  // Check if data is already in flame graph format
  let root;
  if (data && data.name === 'root' && data.children) {
    // Data is already in flame graph format
    root = d3.hierarchy(data)
      .sum(d => d.value || 1)
      .sort((a, b) => b.value - a.value);
  } else {
    // Convert performance data to flame graph format
    const flameData = convertToFlameGraphData(data);
    root = d3.hierarchy({ name: 'root', children: flameData })
      .sum(d => d.value || 1)
      .sort((a, b) => b.value - a.value);
  }

  if (!root.children || root.children.length === 0) {
    svg.append('text')
      .attr('x', width / 2)
      .attr('y', height / 2)
      .attr('text-anchor', 'middle')
      .text('No flame graph data available');
    console.log('No flame graph data available');
    return;
  }

  // Create partition layout (icicle plot)
  const partition = d3.partition()
    .size([width, height])
    .padding(1);

  partition(root);

  // Create color scale
  const color = d3.scaleOrdinal(d3.schemeCategory10);

  // Create zoom behavior
  const zoom = d3.zoom()
    .scaleExtent([1, 8])
    .translateExtent([[-margin.left, -margin.top], [width - margin.right, height - margin.bottom]])
    .on('zoom', (event) => {
      const { transform } = event;
      g.attr('transform', `translate(${margin.left + transform.x},${margin.top + transform.y}) scale(${transform.k})`);
    });

  svg.call(zoom);

  // Create main group
  const g = svg.append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  // Add rectangles
  const nodes = g.selectAll('g')
    .data(root.descendants())
    .enter()
    .append('g')
    .attr('transform', d => `translate(${d.x0},${d.y0})`);

  nodes.append('rect')
    .attr('width', d => d.x1 - d.x0)
    .attr('height', d => d.y1 - d.y0)
    .attr('fill', d => color(d.data.name))
    .attr('stroke', '#fff')
    .attr('stroke-width', 0.5)
    .style('cursor', 'pointer')
    .on('click', (event, d) => {
      // Zoom to clicked node
      const bounds = event.currentTarget.getBBox();
      const dx = bounds.width;
      const dy = bounds.height;
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      const scale = Math.max(1, Math.min(8, 0.9 / Math.max(dx / (width - margin.left - margin.right), dy / (height - margin.top - margin.bottom))));
      const translate = [-x * scale + (width - margin.left - margin.right) / 2, -y * scale + (height - margin.top - margin.bottom) / 2];

      svg.transition()
        .duration(750)
        .call(zoom.transform, d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale));
    });

  // Add text labels
  nodes.append('text')
    .attr('x', 3)
    .attr('y', 13)
    .attr('font-size', d => Math.min(12, (d.x1 - d.x0) / 8))
    .attr('fill', '#fff')
    .attr('pointer-events', 'none')
    .text(d => (d.x1 - d.x0) > 50 ? d.data.name.substring(0, Math.floor((d.x1 - d.x0) / 8)) : '');

  // Add tooltips
  nodes.append('title')
    .text(d => `${d.data.name}\nTime: ${d.value}ms\nDepth: ${d.depth}`);

  // Search functionality
  const searchInput = document.getElementById('flameSearch');
  const searchBtn = document.getElementById('flameSearchBtn');
  const resetBtn = document.getElementById('flameResetBtn');
  const infoSpan = document.getElementById('flameInfo');

  if (searchInput && searchBtn && resetBtn && infoSpan) {
    const updateSearch = () => {
      const query = searchInput.value.toLowerCase();
      if (!query) {
        // Reset all
        nodes.select('rect').attr('opacity', 1);
        infoSpan.textContent = '';
        return;
      }

      let matchCount = 0;
      nodes.each(function(d) {
        const rect = d3.select(this).select('rect');
        const matches = d.data.name.toLowerCase().includes(query);
        rect.attr('opacity', matches ? 1 : 0.3);
        if (matches) matchCount++;
      });

      infoSpan.textContent = `Found ${matchCount} matches`;
    };

    searchBtn.addEventListener('click', updateSearch);
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') updateSearch();
    });

    resetBtn.addEventListener('click', () => {
      searchInput.value = '';
      updateSearch();
      // Reset zoom
      svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity);
    });
  }

  console.log('Flame graph rendered successfully with advanced features');
}

// Convert performance data to flame graph format
function convertToFlameGraphData(data) {
  if (!data || data.length === 0) return [];

  // Group data by function names and calculate total time
  const functionMap = new Map();

  data.forEach(entry => {
    if (entry.stack && Array.isArray(entry.stack)) {
      entry.stack.forEach(frame => {
        const key = frame.functionName || frame.fileName || 'unknown';
        if (!functionMap.has(key)) {
          functionMap.set(key, { name: key, value: 0, count: 0 });
        }
        const func = functionMap.get(key);
        func.value += entry.cpu.user + entry.cpu.system; // Use CPU time as value
        func.count += 1;
      });
    }
  });

  // Convert to array and sort by value
  return Array.from(functionMap.values())
    .sort((a, b) => b.value - a.value)
    .slice(0, 50); // Limit to top 50 functions
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
  initFlameGraph();
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
    case 'perf.flameGraphData':
      console.log('Received flame graph data:', message.payload.data);
      if (message.payload.data) {
        renderFlameGraph(message.payload.data, 'flameGraph');
      }
      break;
  }
});
