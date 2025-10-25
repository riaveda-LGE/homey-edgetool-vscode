// === src/extension/update/updater.ts ===
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { getLogger } from '../../core/logging/extension-logger.js';
import { globalProfiler } from '../../core/logging/perf.js';
import {
  FETCH_BUFFER_TIMEOUT_MS,
  FETCH_JSON_TIMEOUT_MS,
  LATEST_JSON_URL,
} from '../../shared/const.js';
import { ErrorCategory, XError } from '../../shared/errors.js';

const log = getLogger('updater');

type LatestJson = {
  id?: string;
  version?: string;
  url?: string; // VSIX 다운로드 URL (releases/download/v<ver>/<file>.vsix)
  sha256?: string;
};

function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split('.').map((n) => parseInt(n || '0', 10));
  const b = current.split('.').map((n) => parseInt(n || '0', 10));
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff > 0) return true;
    if (diff < 0) return false;
  }
  return false;
}

async function fetchJson<T>(url: string, timeoutMs = FETCH_JSON_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new XError(ErrorCategory.Network, `HTTP ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

async function fetchBuffer(url: string, timeoutMs = FETCH_BUFFER_TIMEOUT_MS): Promise<Buffer> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  } finally {
    clearTimeout(t);
  }
}

function calcSha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function downloadFile(
  url: string,
  destPath: string,
  progress?: (downloaded: number, total: number) => void,
): Promise<void> {
  const buffer = await fetchBuffer(url);
  await fs.promises.writeFile(destPath, buffer);
  if (progress) {
    progress(buffer.length, buffer.length);
  }
}

async function computeSha256(filePath: string): Promise<string> {
  const buffer = await fs.promises.readFile(filePath);
  return calcSha256(buffer);
}

export async function checkLatestVersion(
  currentVersion: string,
): Promise<{ hasUpdate: boolean; latest?: string; url?: string; sha256?: string }> {
  log.debug('[debug] checkLatestVersion: start');
  return globalProfiler.measureFunction('checkLatestVersion', async () => {
    try {
      const data = await fetchJson<LatestJson>(LATEST_JSON_URL);

      const latest = String(data.version ?? '').trim();
      const url = String(data.url ?? '').trim();
      const sha256 = String(data.sha256 ?? '').trim();

      const hasUpdate = !!latest && isNewerVersion(latest, currentVersion);
      log.info(
        `checkLatestVersion: current=${currentVersion}, latest=${latest || '(none)'}, hasUpdate=${hasUpdate}, url=${url || '(none)'}, sha256=${sha256 ? sha256.slice(0, 8) + '…' : '(none)'}`,
      );

      if (hasUpdate && !url) {
        log.warn(`latest.json has newer version ${latest} but missing url`);
        log.debug('[debug] checkLatestVersion: end');
        return { hasUpdate: false, latest, url: undefined, sha256: undefined };
      }

      log.debug('[debug] checkLatestVersion: end');
      return { hasUpdate, latest, url, sha256: sha256 || undefined };
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      // 마켓플레이스 등 404는 정보 없음으로 간주(기능엔 영향 없음)
      if (/HTTP\s+404\b/i.test(msg)) {
        log.warn(`checkLatestVersion: latest.json not found (404) - skipping update check`);
        log.debug('[debug] checkLatestVersion: end');
        return { hasUpdate: false };
      }
      log.error(`checkLatestVersion failed: ${msg}`);
      log.debug('[debug] checkLatestVersion: end');
      return { hasUpdate: false };
    }
  });
}

export async function downloadAndInstall(
  url: string,
  sha256: string,
  onProgress?: (progress: number) => void,
): Promise<void> {
  log.debug('[debug] downloadAndInstall: start');
  return globalProfiler.measureFunction('downloadAndInstall', async () => {
    try {
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'homey-edgetool-update-'));
      const tempFile = path.join(tempDir, 'update.vsix');

      log.info(`downloadAndInstall: downloading ${url} to ${tempFile}`);
      await downloadFile(url, tempFile, onProgress);

      log.info(`downloadAndInstall: verifying sha256 ${sha256}`);
      const actualSha256 = await computeSha256(tempFile);
      if (actualSha256 !== sha256) {
        throw new Error(`SHA256 mismatch: expected ${sha256}, got ${actualSha256}`);
      }

      log.info(`downloadAndInstall: installing ${tempFile}`);
      await vscode.commands.executeCommand(
        'workbench.extensions.installExtension',
        vscode.Uri.file(tempFile),
      );

      log.info('downloadAndInstall: installation command executed, waiting for reload prompt');

      const choice = await vscode.window.showInformationMessage(
        '새 버전이 설치되었습니다. VS Code를 다시 로드하시겠습니까?',
        '지금 다시 로드',
        '나중에',
      );

      if (choice === '지금 다시 로드') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }

      log.info('downloadAndInstall: cleaning up');
      await fs.promises.rm(tempDir, { recursive: true, force: true });
      log.debug('[debug] downloadAndInstall: end');
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      log.error(`downloadAndInstall failed: ${msg}`);
      log.debug('[debug] downloadAndInstall: end');
      throw err;
    }
  });
}
