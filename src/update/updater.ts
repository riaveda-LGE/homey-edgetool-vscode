import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { getLogger } from '../util/extension-logger.js';

const log = getLogger('updater');

export async function checkLatestVersion(
  currentVersion: string,
): Promise<{ hasUpdate: boolean; latest?: string; url?: string }> {
  const serverUrl = 'http://localhost:8080/latest.json';

  try {
    const res = await fetch(serverUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const latest = String(data.version ?? '').trim();
    // latest.json이 vsixUrl을 쓸 수도 있으니 폴백 지원
    const url = String(data.url ?? data.vsixUrl ?? '').trim();

    const hasUpdate = !!latest && isNewerVersion(latest, currentVersion);
    log.info(
      `checkLatestVersion: current=${currentVersion}, latest=${latest}, hasUpdate=${hasUpdate}, url=${url || '(none)'}`,
    );

    // 새 버전인데 url이 없으면 업데이트 제공 불가로 간주
    if (hasUpdate && !url) {
      log.warn(`latest.json has newer version ${latest} but missing url/vsixUrl`);
      return { hasUpdate: false, latest, url: undefined };
    }

    return { hasUpdate, latest, url };
  } catch (err) {
    log.error(`checkLatestVersion failed: ${(err as Error).message}`);
    return { hasUpdate: false };
  }
}

function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff > 0) return true;
    if (diff < 0) return false;
  }
  return false;
}

export async function downloadAndInstall(url: string, progressCallback: (line: string) => void) {
  try {
    if (!url) {
      progressCallback('[update] 최신 버전 URL이 없습니다.');
      return;
    }

    progressCallback('[update] 최신 버전 다운로드 중...');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`다운로드 실패: HTTP ${res.status}`);

    // ✅ __dirname 대신 OS 임시 폴더 사용
    const tmpDir = path.join(os.tmpdir(), 'homey-edgetool');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const filePath = path.join(tmpDir, 'latest.vsix');

    const buf = Buffer.from(await res.arrayBuffer());
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
