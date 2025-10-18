// webpack.config.js
import CopyWebpackPlugin from 'copy-webpack-plugin';
import webpack from 'webpack';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// argv.mode를 신뢰해 모드/분기 일관화
export default (_env, argv) => {
  const mode = argv?.mode ?? 'production';
  const isProd = mode === 'production';

  return {
    // DEV/PROD 전환
    mode,

  // DEV: 인라인 소스맵(외부 .map 파일 없이 VS Code에서 바로 매핑)
  // PROD: 소스맵 제거
  devtool: isProd ? false : 'inline-source-map',

  entry: {
    'edge-panel/app': path.resolve(__dirname, 'src/webviewers/edge-panel/app/index.ts'),
    'log-viewer/app': path.resolve(__dirname, 'src/webviewers/log-viewer/app/index.ts'),
    'perf-monitor/app': path.resolve(__dirname, 'src/webviewers/perf-monitor/app.js'),
  },

  output: {
    // 웹뷰 번들은 dist/webviewers 아래로만 출력 (extension 번들과 분리)
    path: path.resolve(__dirname, 'dist/webviewers'),
    filename: '[name].bundle.js',
    // 이 clean은 output.path(=dist/webviewers)만 청소 → 배포용 dist/extension 산출물엔 영향 없음
    clean: true,
  },

  resolve: {
    extensions: ['.ts', '.js'],
    extensionAlias: { '.js': ['.ts', '.js'] },
    alias: {
      '@ipc': path.resolve(__dirname, 'src/shared/ipc'),
    },
  },

  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'ts-loader',
          options: {
            // 웹뷰 전용 TS 설정(ESM 확장자 강제 경고/implicit any 등 해소)
            configFile: path.resolve(__dirname, 'tsconfig.webview.json'),
            transpileOnly: true, // 속도↑ (타입체크는 IDE/빌드 단계에서 별도)
          },
        },
        exclude: /node_modules/,
      },
    ],
  },

  externals: { vscode: 'commonjs vscode' },

  // 단일 번들 전략 → VS Code Webview/CSP 안정성
  optimization: { splitChunks: false },

  // DEV에서는 번들 사이즈 경고 끔, PROD에서는 기본 경고
  performance: { hints: isProd ? 'warning' : false },

  // DEV 빌드 속도 개선: 파일 시스템 캐시
  cache: isProd ? false : { type: 'filesystem' },

  plugins: [
    // 웹뷰/번들에서 모드 분기를 쉽게 하도록 주입
    new webpack.DefinePlugin({
      __ESD__: JSON.stringify(!isProd),
      // ⛔️ 중복 정의 제거: webpack이 mode에 따라 자동 주입함
      // 'process.env.NODE_ENV': JSON.stringify(mode),
      'process.env.EXT_MODE': JSON.stringify(isProd ? 'prod' : 'esd'),
    }),
    new CopyWebpackPlugin({
      patterns: [
        // ── edge-panel ─────────────────────────────────────────────
        {
          from: path.resolve(__dirname, 'src/webviewers/edge-panel/index.html'),
          to: 'edge-panel/index.html',
        },
        {
          context: path.resolve(__dirname, 'src/webviewers/edge-panel'),
          from: 'styles/*.css',
          to: 'edge-panel/styles/[name][ext]',
          noErrorOnMissing: true,
        },

        // ── log-viewer ─────────────────────────────────────────────
        {
          from: path.resolve(__dirname, 'src/webviewers/log-viewer/index.html'),
          to: 'log-viewer/index.html',
          noErrorOnMissing: true,
        },
        {
          context: path.resolve(__dirname, 'src/webviewers/log-viewer'),
          from: 'styles/*.css',
          to: 'log-viewer/styles/[name][ext]',
          noErrorOnMissing: true,
        },

        // ── perf-monitor ───────────────────────────────────────────
        {
          context: path.resolve(__dirname, 'src/webviewers/perf-monitor'),
          from: '*.css',
          to: 'perf-monitor/[name][ext]',
          noErrorOnMissing: true,
        },
        {
          context: path.resolve(__dirname, 'src/webviewers/perf-monitor'),
          from: '*.html',
          to: 'perf-monitor/[name][ext]',
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(__dirname, 'node_modules/chart.js/dist/chart.umd.js'),
          to: 'perf-monitor/chart.umd.js'
        },
      ],
    }),
  ],
  };
};
