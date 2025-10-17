// webpack.config.js
import path from 'path';
import { fileURLToPath } from 'url';
import CopyWebpackPlugin from 'copy-webpack-plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  mode: 'production',
  entry: {
    'edge-panel/app': path.resolve(__dirname, 'src/webviewers/edge-panel/app/index.ts'),
    'log-viewer/app': path.resolve(__dirname, 'src/webviewers/log-viewer/app.ts'),
    'perf-monitor/app': path.resolve(__dirname, 'src/webviewers/perf-monitor/app.js'),
  },
  output: {
    path: path.resolve(__dirname, 'dist/webviewers'),
    filename: '[name].bundle.js',
    clean: true,
  },
  resolve: {
    extensions: ['.ts', '.js'],
    extensionAlias: { '.js': ['.ts', '.js'] },
  },
  module: {
    rules: [
      { test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ },
    ],
  },
  externals: { vscode: 'commonjs vscode' },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        // edge-panel html
        {
          from: path.resolve(__dirname, 'src/webviewers/edge-panel/index.html'),
          to: 'edge-panel/index.html',
        },
        // edge-panel css
        {
          context: path.resolve(__dirname, 'src/webviewers/edge-panel'),
          from: 'styles/*.css',
          to: 'edge-panel/styles/[name][ext]',
          noErrorOnMissing: true,
        },

        // log-viewer assets (필요 시)
        { from: path.resolve(__dirname, 'src/webviewers/log-viewer/*.html'), to: 'log-viewer/[name][ext]', noErrorOnMissing: true },
        { from: path.resolve(__dirname, 'src/webviewers/log-viewer/*.css'), to: 'log-viewer/[name][ext]', noErrorOnMissing: true },

        // ✅ perf-monitor css (루트에 있는 style.css 복사)
        {
          context: path.resolve(__dirname, 'src/webviewers/perf-monitor'),
          from: '*.css',                 // style.css
          to: 'perf-monitor/[name][ext]',
          noErrorOnMissing: true,
        },
        // perf-monitor html(사용 안 해도 무방, 남겨둠)
        {
          context: path.resolve(__dirname, 'src/webviewers/perf-monitor'),
          from: '*.html',
          to: 'perf-monitor/[name][ext]',
          noErrorOnMissing: true,
        },
        // chart.js
        { from: path.resolve(__dirname, 'node_modules/chart.js/dist/chart.umd.js'), to: 'perf-monitor/chart.umd.js' },
      ],
    }),
  ],
};
