import { connectionManager } from '../../connection/ConnectionManager.js';
import { getLogger } from '../../logging/extension-logger.js';

const log = getLogger('HostGuard');

export class HostStateGuard {
   async waitForUnitActive(unit: string, timeoutMs = 30_000, pollMs = 1500) {
     const deadline = Date.now() + timeoutMs;
     const showCmd =
       `SYSTEMD_PAGER= systemctl show -p ActiveState -p SubState -p ExecMainPID ${q(unit)} 2>/dev/null | ` +
       `sed -n 's/^\\(ActiveState\\|SubState\\|ExecMainPID\\)=//p'`;
     while (Date.now() < deadline) {
       // 1) 엄격 확인: show 파싱
       const { stdout } = await connectionManager.run(`sh -lc ${q(showCmd)}`);
       const lines = String(stdout || '').trim().split(/\r?\n/);
       if (lines.length >= 3) {
         const active = lines[0]?.trim();
         const sub    = lines[1]?.trim();
         const pid    = Number(lines[2]?.trim() || '0');
         if (active === 'active' && sub === 'running' && pid > 0) return true;
       } else {
         // 2) 폴백: is-active
         const { stdout: s2 } = await connectionManager.run(
           `sh -lc 'systemctl is-active ${q(unit)} 2>/dev/null || true'`,
         );
         if (String(s2).trim() === 'active') return true;
       }
       await sleep(pollMs);
     }
     return false;
  }

  async waitForNoContainers(match: string, timeoutMs = 15_000, pollMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { stdout } = await connectionManager.run(
        `sh -lc 'docker ps -a --format "{{.Names}}" | grep -E "${sq(match)}" || true'`,
      );
      if (!String(stdout || '').trim()) return true;
      await sleep(pollMs);
    }
    return false;
  }

  async ensureFsRemountRW(root: string = '/') {
    try {
      await connectionManager.run(`sh -lc 'mount -o remount,rw ${root} || true'`);
      return true;
    } catch {
      return false;
    }
  }

  async stopContainersByMatch(match: string, tries = 3, backoffMs = 2000) {
    for (let i = 0; i < tries; i++) {
      await connectionManager.run(
        `sh -lc 'docker ps -a --format "{{.Names}}" | grep -E "${sq(match)}" | xargs -r -n1 sh -c '\''docker stop "$0" || true'\'''`,
      );
      const ok = await this.waitForNoContainers(match, backoffMs, 500);
      if (ok) return true;
      await sleep(backoffMs * (i + 1));
    }
    log.warn(`stopContainersByMatch: containers may still exist for /${match}/`);
    return false;
  }

  // 서비스 파일 변경(해시) 대기 — sha256sum 없으면 md5sum 폴백
  async waitForServiceFileChange(file: string, timeoutMs = 8000, pollMs = 500) {
    const hashCmd = `sh -lc 'if command -v sha256sum >/dev/null 2>&1; then sha256sum ${q(file)} | cut -d" " -f1; else md5sum ${q(file)} | cut -d" " -f1; fi'`;
    const before = String((await connectionManager.run(hashCmd)).stdout || '').trim();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const now = String((await connectionManager.run(hashCmd)).stdout || '').trim();
      if (now && before && now !== before) return true;
      await sleep(pollMs);
    }
    return false;
  }
}

function sq(s: string) { return String(s).replace(/'/g, `'\\''`); }
function q(s: string) { return `'${String(s).replace(/'/g, `'''`)}'`; }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }