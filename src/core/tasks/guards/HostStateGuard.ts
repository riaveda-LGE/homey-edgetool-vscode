import { connectionManager } from '../../connection/ConnectionManager.js';
import { getLogger } from '../../logging/extension-logger.js';

const log = getLogger('HostGuard');

export class HostStateGuard {
  /** 안전 실행: sh -lc '<script>' _ 'arg1' 'arg2' … 로 전달해 인자 이스케이프 문제 제거 */
  private async runShArgs(script: string, ...args: string[]) {
    const tail = args.map((a) => q(a)).join(' ');
    return await connectionManager.run(`sh -lc ${q(script)} ${tail ? ` _ ${tail}` : ''}`);
  }
  /**
   * unit이 활성화되었는지 대기.
   * 기본 정책을 완화해 detach형 서비스(예: docker run -d → active(exited))도 성공으로 인정한다.
   * 기존 호출부 서명을 깨지 않기 위해 opts는 선택 인자로 추가.
   */
  async waitForUnitActive(
    unit: string,
    timeoutMs = 30_000,
    pollMs = 1500,
    opts?: {
      /** SubState=exited 를 성공으로 인정 (detach/service형) */
      acceptExited?: boolean;
      /** SubState=listening 을 성공으로 인정 (socket/listen형) */
      acceptListening?: boolean;
      /** 매 반복에서 systemctl is-active == active 면 성공으로 인정 */
      fallbackIsActive?: boolean;
      /** 성공 판정에 ExecMainPID>0 조건을 추가로 요구 */
      requirePid?: boolean;
    },
  ) {
    const o = {
      acceptExited: true,
      acceptListening: true,
      fallbackIsActive: true,
      requirePid: false,
      ...(opts ?? {}),
    };

    const deadline = Date.now() + timeoutMs;
   const showCmd =
      `SYSTEMD_PAGER= systemctl show -p ActiveState -p SubState -p ExecMainPID ${q(unit)} 2>/dev/null`;
    log.debug(`waitForUnitActive: showCmd=${showCmd}`);

    while (Date.now() < deadline) {
      // 1) key=value로 안정 파싱(순서 비의존)
      const { stdout } = await connectionManager.run(`sh -lc ${q(showCmd)}`);
      const map: Record<string, string> = {};
      String(stdout || '')
        .trim()
        .split(/\r?\n/)
        .forEach((ln) => {
          const m = ln.match(/^([^=]+)=(.*)$/);
          if (m) map[m[1]] = m[2];
        });
      const active = map['ActiveState']?.trim();
      const sub = map['SubState']?.trim();
      const pid = Number((map['ExecMainPID'] ?? '').trim() || '0');
      log.debug(`waitForUnitActive: active=${active} sub=${sub} pid=${pid}`);
      if (active === 'active') {
          const subOk =
            sub === 'running' ||
            (o.acceptExited && sub === 'exited') ||
            (o.acceptListening && sub === 'listening');

          // sub 상태가 허용되고, 필요 시 PID 조건까지 만족하면 성공
          if (subOk && (!o.requirePid || pid > 0)) {
            return true;
          }

          // 일부 Type=simple 등은 sub가 running이더라도 pid만 의미가 있을 수 있어 보조 허용
          if (!o.requirePid && pid > 0) {
            return true;
          }
      }

      // 2) 폴백: is-active (항상 안전망으로 확인)
      if (o.fallbackIsActive) {
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
      // 인자를 $1로 받아 grep에 전달 — 따옴표 충돌/이스케이프 제거
      const script =
        'docker ps -a --format "{{.Names}}" | grep -E "$1" 2>/dev/null || true';
      const { stdout } = await this.runShArgs(script, match);
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

  /** 이름이 정규식에 매칭되는 컨테이너를 '정지 후 제거'한다. (docker stop → docker rm)
   *  검증은 항상 `docker ps -a` 기준으로 수행되어 Exited 잔존 컨테이너도 허용하지 않는다. */
  async stopContainersByMatch(match: string, tries = 3, backoffMs = 2000) {
    for (let i = 0; i < tries; i++) {
      // BusyBox 호환: xargs -r 의존 회피, 중첩 sh -c 제거
      // 1) 후보 이름 수집 → 비었으면 스킵
      // 2) 있으면 stop → rm 순으로 처리
      const script = [
        'names=$(docker ps -a --format "{{.Names}}" | grep -E "$1" 2>/dev/null || true)',
        '[ -z "$names" ] || echo "$names" | xargs -n1 -I{} docker stop "{}" >/dev/null 2>&1 || true',
        '[ -z "$names" ] || echo "$names" | xargs -n1 -I{} docker rm "{}" >/dev/null 2>&1 || true',
      ].join(' ; ');
      await this.runShArgs(script, match);
      const ok = await this.waitForNoContainers(match, backoffMs, 500);
      if (ok) return true;
      await sleep(backoffMs * (i + 1));
    }
    log.warn(`stopContainersByMatch: containers may still exist for /${match}/`);
    return false;
  }

  // ── Docker volumes (by explicit names) ─────────────────────────
  /** 주어진 볼륨 이름들이 모두 사라질 때까지 대기 */
  async waitForVolumesGone(names: string[], timeoutMs = 10_000, pollMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { stdout } = await connectionManager.run(
        `sh -lc 'docker volume ls --format "{{.Name}}" 2>/dev/null || true'`,
      );
      const set = new Set(
        String(stdout || '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const anyExist = names.some((n) => set.has(n));
      if (!anyExist) return true;
      await sleep(pollMs);
    }
    return false;
  }

  /** 명시된 볼륨 이름들을 제거한다. 실패 시 재시도(backoff 포함) */
  async removeVolumesByNames(names: string[], tries = 2, backoffMs = 1500) {
    const vols = Array.from(new Set(names.filter(Boolean)));
    if (!vols.length) return true;
    for (let i = 0; i < tries; i++) {
      // 개별 삭제 시도 (존재하지 않으면 무시)
      for (const v of vols) {
        await connectionManager.run(
          `sh -lc 'docker volume rm ${q(v)} >/dev/null 2>&1 || true'`,
        );
      }
      const ok = await this.waitForVolumesGone(vols, backoffMs, 400);
      if (ok) return true;
      await sleep(backoffMs * (i + 1));
    }
    log.warn(`removeVolumesByNames: some volumes may still exist: ${names.join(', ')}`);
    return false;
  }

  // 서비스 파일 변경(해시) 대기 — sha256sum 없으면 md5sum 폴백
  async waitForServiceFileChange(
    file: string,
    timeoutMs = 30_000,
    pollMs = 1500,
    beforeHash?: string,
  ) {
    const hashCmd = `sh -lc 'if command -v sha256sum >/dev/null 2>&1; then sha256sum ${q(
      file,
    )} | cut -d" " -f1; else md5sum ${q(file)} | cut -d" " -f1; fi'`;
    log.debug(`waitForServiceFileChange: hashCmd=${hashCmd}`);
    const before = beforeHash ?? String((await connectionManager.run(hashCmd)).stdout || '').trim();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const now = String((await connectionManager.run(hashCmd)).stdout || '').trim();
      if (now && before && now !== before) return true;
      await sleep(pollMs);
    }
    return false;
  }
}

function sq(s: string) {
  return String(s).replace(/'/g, `'\\''`);
}
// 안전 싱글쿼트 래퍼: 'foo bar' 형태로 감싼다
function q(s: string) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}