import * as vscode from 'vscode';

import { connectionManager } from '../connection/ConnectionManager.js';
import { getLogger } from '../logging/extension-logger.js';
import { resolveHomeyUnit } from '../service/serviceDiscovery.js';
import { ServiceFilePatcher } from '../service/ServiceFilePatcher.js';

const log = getLogger('DeviceState');

export type MountState = 'mounted' | 'unmounted' | 'unknown';

/**
 * Docker 볼륨 존재 여부로 마운트 상태를 판단한다.
 * - 대상 볼륨: homey-app, homey-node
 * - 활성 연결이 없으면 'unknown'
 * - 둘 중 하나라도 존재하면 'mounted', 모두 없으면 'unmounted'
 */
export async function getMountState(_ctx?: vscode.ExtensionContext): Promise<MountState> {
  try {
    // 활성 연결이 없으면 판단 불가
    if (!connectionManager.isConnected()) return 'unknown';

    // 볼륨 목록 조회(이름만)
    const { stdout } = await connectionManager.run(
      `sh -lc 'docker volume ls --format "{{.Name}}" 2>/dev/null || true'`,
    );

    const names = new Set(
      String(stdout || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    );

    // UnmountTaskRunner의 기본 패턴과 동일한 이름을 기준으로 판정
    const targets = ['homey-app', 'homey-node'];
    const anyExist = targets.some((n) => names.has(n));

    log.debug(
      `[DeviceState] mount check via volumes: exists=${anyExist} volumes=${Array.from(names).join(
        ',',
      )}`,
    );

    return anyExist ? ('mounted' as const) : ('unmounted' as const);
  } catch (e) {
    log.warn(`[DeviceState] getMountState failed: ${e instanceof Error ? e.message : String(e)}`);
    return 'unknown';
  }
}

/**
 * 서비스 유닛 파일에서 토글 변수 존재 여부로 활성 상태를 판정한다.
 * @param varName 'HOMEY_APP_LOG' | 'HOMEY_DEV_TOKEN'
 */
export async function getEnvToggleEnabled(
  varName: 'HOMEY_APP_LOG' | 'HOMEY_DEV_TOKEN',
): Promise<boolean> {
  try {
    if (!connectionManager.isConnected()) return false;
    const unit = await resolveHomeyUnit();
    const svc = new ServiceFilePatcher(unit);
    const svcPath = await svc.resolveServicePath();
    // ServiceFilePatcher.contains(file, markerRe) — 여기서는 varName 토큰으로 부분 일치
    const on = await svc.contains(svcPath, varName);
    log.debug(`[DeviceState] ${varName} enabled=${on}`);
    return !!on;
  } catch (e) {
    log.warn(
      `[DeviceState] getEnvToggleEnabled(${varName}) failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}
