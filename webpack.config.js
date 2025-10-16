import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  mode: 'production',
  entry: {
    'edge-panel/panel': path.resolve(__dirname, 'src/webviewers/edge-panel/panel.ts'),
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
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  externals: {
    vscode: 'commonjs vscode',
  },
};
