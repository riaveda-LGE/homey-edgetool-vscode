// === src/extension/update/updater.ts ===
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { getLogger } from '../../core/logging/extension-logger.js';
import {
  LATEST_JSON_URL,
  FETCH_JSON_TIMEOUT_MS,
  FETCH_BUFFER_TIMEOUT_MS,
} from '../../shared/const.js';

const log = getLogger('updater');

type LatestJson = {
  id?: string;
  version?: string;
  url?: string;     // VSIX 다운로드 URL (releases/download/v<ver>/<file>.vsix)
  sha256?: string;
};

function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split('.').map(n => parseInt(n || '0', 10));
  const b = current.split('.').map(n => parseInt(n || '0', 10));
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
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
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

export async function checkLatestVersion(
  currentVersion: string,
): Promise<{ hasUpdate: boolean; latest?: string; url?: string; sha256?: string }> {
  try {
    const data = await fetchJson<LatestJson>(LATEST_JSON_URL);

    const latest = String(data.version ?? '').trim();
    const url = String(data.url ?? '').trim();
    const sha256 = String(data.sha256 ?? '').trim();

    const hasUpdate = !!latest && isNewerVersion(latest, currentVersion);
    log.info(
      `checkLatestVersion: current=${currentVersion}, latest=${latest || '(none)'}, hasUpdate=${hasUpdate}, url=${url || '(none)'}, sha256=${sha256 ? sha256.slice(0, 8) + '…' : '(none)'}`
    );

    if (hasUpdate && !url) {
      log.warn(`latest.json has newer version ${latest} but missing url`);
      return { hasUpdate: false, latest, url: undefined, sha256: undefined };
    }

    return { hasUpdate, latest, url, sha256: sha256 || undefined };
  } catch (err) {
    log.error(`checkLatestVersion failed: ${(err as Error).message}`);
    return { hasUpdate: false };
  }
}

export async function downloadAndInstall(
  url: string,
  progressCallback: (line: string) => void,
  expectedSha?: string,
) {
  try {
    if (!url) {
      progressCallback('[update] 최신 버전 URL이 없습니다.');
      return;
    }

    progressCallback('[update] 최신 버전 다운로드 중...');
    const buf = await fetchBuffer(url);

    if (expectedSha) {
      const actual = calcSha256(buf);
      if (actual !== expectedSha.toLowerCase()) {
        throw new Error(`무결성 검증 실패: expected ${expectedSha}, got ${actual}`);
      }
      progressCallback('[update] 무결성 검증 완료 (SHA-256 일치).');
    } else {
      progressCallback('[update] 참고: sha256이 없어 무결성 검증을 건너뜁니다.');
    }

    const tmpDir = path.join(os.tmpdir(), 'homey-edgetool');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const filePath = path.join(tmpDir, 'latest.vsix');
    fs.writeFileSync(filePath, buf);

    progressCallback(`[update] 다운로드 완료: ${filePath}`);
    progressCallback('[update] 설치를 시작합니다...');

    await vscode.commands.executeCommand(
      'workbench.extensions.installExtension',
      vscode.Uri.file(filePath),
    );

    progressCallback('[update] 설치가 완료되었습니다.');
    progressCallback('[update] "Developer: Reload Window" 버튼을 눌러주세요.');
    progressCallback(
      '[update] 또는 Ctrl + Shift + P 를 누르고 "Developer: Reload Window" 를 실행하세요.',
    );
  } catch (err) {
    log.error('downloadAndInstall failed', err);
    progressCallback(`[update] 업데이트 실패: ${(err as Error).message}`);
  }
}
