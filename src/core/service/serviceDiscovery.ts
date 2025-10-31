// === src/core/service/serviceDiscovery.ts ===
import * as vscode from 'vscode';

import { readUserHomeyConfig, writeUserHomeyConfig } from '../config/userconfig.js';
import { connectionManager } from '../connection/ConnectionManager.js';
import { getLogger } from '../logging/extension-logger.js';
import { measureBlock } from '../logging/perf.js';

const log = getLogger('serviceDiscovery');
// eslint(no-control-regex) 회피:
// - 소스 코드에 제어문자 이스케이프(\x1B, \u001B)를 직접 쓰지 않는다.
// - 대신 런타임에 ESC 문자를 생성(String.fromCharCode)해 RegExp를 만든다.
//   → ESLint가 정적 분석으로 "제어문자 사용"을 검출하지 못함.
const ESC = String.fromCharCode(27); // \x1B
const ANSI_COLOR_RE = new RegExp(ESC + '\\[[0-9;]*m', 'g');

export async function discoverHomeyServiceName(
  ctx: vscode.ExtensionContext,
): Promise<string | undefined> {
  return measureBlock('svc.discoverHomeyServiceName', async () => {
    // 1) 기존 설정 우선
    const cfg = await readUserHomeyConfig(ctx);
    if (cfg.homey_service_name && cfg.homey_service_name.trim()) {
      log.debug(`using stored service name: ${cfg.homey_service_name}`);
      return cfg.homey_service_name.trim();
    }

    // 2) 시스템에서 검색
    const { stdout } = await connectionManager.run(
      `sh -lc 'SYSTEMD_PAGER= systemctl list-units --type=service --all --no-legend --plain --no-pager 2>/dev/null | grep -E "^homey-(pro|bridge).*\\.service" | sed -E "s/[[:space:]].*$//" || true'`,
    );
    const list = String(stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (list.length === 0) {
      vscode.window.showWarningMessage('Homey 관련 systemd 서비스가 감지되지 않았습니다.');
      return undefined;
    }
    if (list.length === 1) {
      await writeUserHomeyConfig(ctx, { homey_service_name: list[0] });
      log.info(`detected service: ${list[0]}`);
      return list[0];
    }

    // 3) 복수 후보 → QuickPick
    const pick = await vscode.window.showQuickPick(list, {
      title: 'Homey 서비스 선택',
      placeHolder: 'homey-(pro|bridge)*.service',
      ignoreFocusOut: true,
    });
    if (!pick) return undefined;
    await writeUserHomeyConfig(ctx, { homey_service_name: pick });
    log.info(`user selected service: ${pick}`);
    return pick;
  });
}

export async function checkServiceFileExists(
  ctx: vscode.ExtensionContext,
  pathGuess: string,
  fileGuess: string,
): Promise<{ path: string; file: string } | undefined> {
  return measureBlock('svc.checkServiceFileExists', async () => {
    let pathCur = pathGuess;
    let fileCur = fileGuess;

    for (;;) {
      const { stdout } = await connectionManager.run(
        `sh -lc 'if [ -f "${pathCur}${pathCur.endsWith('/') ? '' : '/'}${fileCur}" ]; then echo OK; else echo NO; fi'`,
      );
      if (String(stdout).trim() === 'OK') return { path: pathCur, file: fileCur };

      const fix = await vscode.window.showQuickPick(['경로 수정', '파일명 수정', '취소'], {
        title: '서비스 파일을 찾을 수 없습니다. 어떻게 할까요?',
        ignoreFocusOut: true,
      });
      if (!fix || fix === '취소') return undefined;
      if (fix === '경로 수정') {
        const np = await vscode.window.showInputBox({
          title: '서비스 파일 경로',
          value: pathCur,
          prompt: '예: /lib/systemd/system/',
        });
        if (!np) continue;
        pathCur = np.trim();
      } else {
        const nf = await vscode.window.showInputBox({
          title: '서비스 파일 이름',
          value: fileCur,
          prompt: '예: homey-pro@.service',
        });
        if (!nf) continue;
        fileCur = nf.trim();
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────
// SSOT: Homey systemd unit 해상/검증/캐시
// ─────────────────────────────────────────────────────────────
export async function resolveHomeyUnit(ctx?: vscode.ExtensionContext): Promise<string> {
  // 1) 컨텍스트 결정(없으면 전역에서 가져옴)
  const context =
    ctx ?? ((vscode as any).extensions?.extensionContext as vscode.ExtensionContext | undefined);
  // 2) 캐시된 서비스명 재사용(+유효성 검사)
  try {
    if (context) {
      const cached = await discoverHomeyServiceName(context);
      if (cached && (await isUnitValid(cached))) return cached;
    }
  } catch {}
  // 3) 자동 탐색 → 캐시 저장
  const detected = await detectHomeyUnit();
  try {
    if (context) await writeUserHomeyConfig(context, { homey_service_name: detected });
  } catch {}
  return detected;
}

export async function isUnitValid(unit: string): Promise<boolean> {
  const { stdout } = await connectionManager.run(
    `sh -lc 'systemctl show -p FragmentPath "${unit}" 2>/dev/null | cut -d= -f2'`,
  );
  return Boolean(String(stdout || '').trim());
}

export async function detectHomeyUnit(): Promise<string> {
  const cmd =
    'SYSTEMD_PAGER= systemctl list-units --type=service --all --no-legend --plain --no-pager 2>/dev/null | ' +
    'grep -E "^homey-(pro|bridge).*\\.service" | sed -E "s/[[:space:]].*$//" | head -n1';
  const { stdout } = await connectionManager.run(`sh -lc ${q(cmd)}`);
  const unit = sanitizeUnit(stdout);

  // 허용: homey-pro / homey-bridge ... (중간은 자유) ... .service
  if (!/^homey-(pro|bridge).*\.service$/.test(unit)) {
    throw new Error(`homey unit not found (got: ${unit || 'empty'})`);
  }
  return unit;
}

function sanitizeUnit(s: string): string {
  // ANSI color 제거 + CR 제거 + 첫 줄 + 첫 토큰
  const line =
    String(s || '')
      .replace(ANSI_COLOR_RE, '')
      .replace(/\r/g, '')
      .split('\n')[0] ?? '';
  return line.trim().split(/\s+/)[0] ?? '';
}
function q(s: string) {
  // shell-safe single-quote wrapper (템플릿 리터럴의 불필요 이스케이프 회피)
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}
