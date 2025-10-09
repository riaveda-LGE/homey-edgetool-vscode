// src/update/updater.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getLogger } from '../util/extension-logger.js';

const log = getLogger('updater');

/** GitHub 리포 정보 */
const GH_OWNER = 'riaveda-LGE';
const GH_REPO  = 'homey-edgetool-vscode';

/** latest 릴리스의 latest.json 고정 URL (토큰 불필요) */
const LATEST_JSON_URL =
  `https://github.com/${GH_OWNER}/${GH_REPO}/releases/latest/download/latest.json`;

type LatestJson = {
  id?: string;
  version?: string;
  url?: string;     // VSIX 다운로드 URL (releases/download/v<ver>/<file>.vsix)
  sha256?: string;
};

/** semver 유사 비교: latest > current ? */
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

/** 네트워크 유틸 */
async function fetchJson<T>(url: string, timeoutMs = 12_000): Promise<T> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

async function fetchBuffer(url: string, timeoutMs = 60_000): Promise<Buffer> {
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

/**
 * 최신 릴리스의 latest.json을 읽어 업데이트 유무/다운로드 URL 반환
 * - latest.json 예시:
 *   { "id":"lge.homey-edgetool", "version":"0.0.3",
 *     "url":"https://github.com/<owner>/<repo>/releases/download/v0.0.3/<basename>-0.0.3.vsix",
 *     "sha256":"..." }
 */
export async function checkLatestVersion(
  currentVersion: string,
): Promise<{ hasUpdate: boolean; latest?: string; url?: string }> {
  try {
    const data = await fetchJson<LatestJson>(LATEST_JSON_URL);

    const latest = String(data.version ?? '').trim();
    const url = String(data.url ?? '').trim();

    const hasUpdate = !!latest && isNewerVersion(latest, currentVersion);
    log.info(
      `checkLatestVersion: current=${currentVersion}, latest=${latest || '(none)'}, hasUpdate=${hasUpdate}, url=${url || '(none)'}`
    );

    // 새 버전인데 url이 없으면 제공 불가로 간주
    if (hasUpdate && !url) {
      log.warn(`latest.json has newer version ${latest} but missing url`);
      return { hasUpdate: false, latest, url: undefined };
    }

    return { hasUpdate, latest, url };
  } catch (err) {
    log.error(`checkLatestVersion failed: ${(err as Error).message}`);
    return { hasUpdate: false };
  }
}

export async function downloadAndInstall(url: string, progressCallback: (line: string) => void) {
  try {
    if (!url) {
      progressCallback('[update] 최신 버전 URL이 없습니다.');
      return;
    }

    progressCallback('[update] 최신 버전 다운로드 중...');
    const buf = await fetchBuffer(url);

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
    progressCallback(
      '[update] Ctrl + Shift + P 를 누르고 "Developer: Reload Window" 를 실행하세요.',
    );
  } catch (err) {
    log.error('downloadAndInstall failed', err);
    progressCallback(`[update] 업데이트 실패: ${(err as Error).message}`);
  }
}
