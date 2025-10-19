/* eslint-env node */

// scripts/deploy.js (ESM)
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
process.chdir(root);

// ────────────────────────────────────────────────────────────────
// 공용 유틸
// ────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(msg);
}
function err(msg) {
  console.error(msg);
}

function spawnProc(cmd, args = [], opts = {}) {
  // Windows에서 code(.cmd) / npm bin 사용 등 고려 → shell:true가 안전
  return spawn(cmd, args, { stdio: 'inherit', shell: true, ...opts });
}

function getCodeCmd() {
  return process.platform === 'win32' ? 'code.cmd' : 'code';
}

function waitForFile(filePath, timeoutMs = 300000, intervalMs = 300) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = globalThis.setInterval(() => {
      try {
        if (fs.existsSync(filePath)) {
          globalThis.clearInterval(timer);
          resolve(true);
        } else if (Date.now() - start > timeoutMs) {
          globalThis.clearInterval(timer);
          reject(new Error(`Timeout waiting for ${filePath}`));
        }
      } catch (e) {
        globalThis.clearInterval(timer);
        reject(e);
      }
    }, intervalMs);
  });
}

async function waitForAll(paths, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  for (const p of paths) {
    const remain = Math.max(0, deadline - Date.now());
    await waitForFile(p, remain || 1);
  }
}

function rimrafDist() {
  try {
    execSync('rimraf dist', { stdio: 'inherit' });
  } catch {}
}

function readPkg() {
  return JSON.parse(fs.readFileSync('package.json', 'utf8'));
}

// ────────────────────────────────────────────────────────────────
// 실행 분기
// ────────────────────────────────────────────────────────────────
const isDev = process.argv.includes('--dev');
const pkg = readPkg();
const version = pkg.version;
const vsix = `homey-edgetool-${version}.vsix`;
// main 엔트리를 package.json의 "main"에서 추적 (구성 변경에도 견고)
const mainEntryPath = path.resolve(root, pkg.main || 'dist/extension/main.js');

if (isDev) {
  // ───────────── DEV: tsc -w + webpack --watch + EDH ─────────────
  log('🧹 Clean dist...');
  rimrafDist();

  // TS 컴파일러 watch
  log('🛠️  Start TypeScript in watch...');
  const tsc = spawnProc('tsc', ['-p', '.', '--watch', '--preserveWatchOutput'], {
    env: { ...process.env, NODE_ENV: 'development', EXT_MODE: 'esd' },
  });

  // webpack watch (복사/번들 + dev 소스맵)
  log('🛠️  Start webpack in watch (development + inline-source-map)...');
  const webpack = spawnProc(
    'cross-env',
    [
      'NODE_ENV=development',
      'webpack',
      '--watch',
      '--mode',
      'development',
      '--devtool',
      'inline-source-map',
    ],
    { env: { ...process.env, NODE_ENV: 'development', EXT_MODE: 'esd' } },
  );

  // EDH 띄우기 전에 필요한 산출물 3가지 모두 대기
  const needFiles = [
    mainEntryPath,
    path.resolve(root, 'dist', 'webviewers', 'edge-panel', 'index.html'),
    path.resolve(root, 'dist', 'webviewers', 'log-viewer', 'index.html'),
  ];

  waitForAll(needFiles, 180000)
    .then(() => {
      log('🚀 Launch Extension Development Host...');
      const codeCmd = getCodeCmd();

      // Windows spawn 이슈 방지: 인자 분리 대신 = 형태 사용
      const args = [`--extensionDevelopmentPath=${root}`, '--inspect-extensions=9229'];
      const edh = spawnProc(codeCmd, args, {
        env: { ...process.env, NODE_ENV: 'development', EXT_MODE: 'esd' },
      });

      // 종료/정리
      const shutdown = () => {
        try {
          tsc.kill();
        } catch {}
        try {
          webpack.kill();
        } catch {}
        try {
          edh.kill();
        } catch {}
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      process.on('exit', shutdown);
    })
    .catch((e) => {
      err(`❌ Failed to detect first build: ${e.message}`);
      process.exit(1);
    });
} else {
  // ───────────── PROD: vsix 패키징 + 설치 ─────────────
  function isInstalled(extId) {
    try {
      const list = execSync(`${getCodeCmd()} --list-extensions`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
      });
      return list.split(/\r?\n/).includes(extId);
    } catch {
      return false;
    }
  }

  try {
    const extId = `${pkg.publisher}.${pkg.name}`;
    if (isInstalled(extId)) {
      log('🔄 Uninstall old extension...');
      execSync(`${getCodeCmd()} --uninstall-extension ${extId}`, { stdio: 'inherit', shell: true });
    } else {
      log(`ℹ️ ${extId} is not installed, skipping uninstall.`);
    }

    log('🧹 Clean dist...');
    rimrafDist();

    log('📦 Package extension...');
    execSync('npm run package', { stdio: 'inherit', shell: true });

    log(`📥 Install ${vsix}...`);
    execSync(`${getCodeCmd()} --install-extension ${vsix}`, { stdio: 'inherit', shell: true });

    log('✅ Deploy finished');
  } catch (e) {
    err(`❌ Deploy failed: ${e.message}`);
    process.exit(1);
  }
}
