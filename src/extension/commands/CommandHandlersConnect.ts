// === src/extension/commands/CommandHandlersConnect.ts ===
import * as vscode from 'vscode';

import {
  type ConnectionInfo,
  markRecent,
  readConnectionConfig,
  saveConnectionConfig,
  upsertConnection,
} from '../../core/config/connection-config.js';
import { getCurrentWorkspacePathFs } from '../../core/config/userdata.js';
import {
  getState as adbGetState,
  listDevices as adbListDevices,
} from '../../core/connection/adbClient.js';
import { connectionManager } from '../../core/connection/ConnectionManager.js';
import { execQuickCheck as sshQuickCheck } from '../../core/connection/sshClient.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';

const log = getLogger('cmd.connect');

export class CommandHandlersConnect {
  constructor(private context?: vscode.ExtensionContext) {
    // ConnectionManager가 recent 자동 활성화를 할 수 있도록 로더 등록
    if (this.context) {
      connectionManager.setRecentLoader(async () => {
        try {
          const base = await getCurrentWorkspacePathFs(this.context!);
          const cfg = await readConnectionConfig(base);
          if (!cfg.recent) return undefined;
          return cfg.connections.find((c) => c.id === cfg.recent);
        } catch {
          return undefined;
        }
      });
    }
  }

  // 진입점: 웹뷰 버튼/커맨드에서 호출
  @measure()
  async connectDevice() {
    const base = await this._resolveWorkspacePath();
    if (!base) return;
    const cfg = await readConnectionConfig(base);

    const pick = await vscode.window.showQuickPick(
      [
        { label: '기존 연결에서 선택', description: '최근/저장된 연결 항목에서 선택' },
        { label: '새 기기 연결', description: 'ADB 또는 SSH 새 연결 생성' },
      ],
      { placeHolder: '연결 방식을 선택하세요' },
    );
    if (!pick) return;

    if (pick.label.startsWith('기존')) {
      await this._pickExisting(base, cfg);
    } else {
      await this._pickNew(base, cfg);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 내부 구현
  // ─────────────────────────────────────────────────────────────
  private async _resolveWorkspacePath(): Promise<string | undefined> {
    if (!this.context) {
      vscode.window.showErrorMessage('확장 컨텍스트가 없습니다.');
      return;
    }
    try {
      return await getCurrentWorkspacePathFs(this.context);
    } catch (e) {
      log.error('workspace path resolve failed', e as any);
      vscode.window.showErrorMessage('작업폴더를 확인할 수 없습니다.');
      return;
    }
  }

  private async _pickExisting(base: string, cfg: any) {
    if (!cfg.connections?.length) {
      vscode.window.showInformationMessage('저장된 연결이 없습니다. 새 기기 연결을 진행합니다.');
      return await this._pickNew(base, cfg);
    }

    const items = await Promise.all(
      cfg.connections.map(async (c: any) => {
        const label = c.alias ? c.alias : c.id;
        let ok = false,
          status = '';
        if (c.type === 'ADB') {
          ok = (await adbGetState((c.details as any).deviceID)) === 'device';
          status = ok ? '정상(ADB)' : '오프라인/미인증(ADB)';
        } else {
          const d = c.details as any;
          ok = await sshQuickCheck({
            host: d.host,
            user: d.user,
            port: d.port,
            password: d.password,
            timeoutMs: 5000,
          });
          status = ok ? '정상(SSH)' : d.password ? '오프라인/인증실패(SSH)' : '비밀번호 없음';
        }
        return {
          label,
          description: `${c.type} · ${status}`,
          detail: c.id,
          picked: cfg.recent === c.id,
        } as vscode.QuickPickItem & { detail: string };
      }),
    );

    const chosen = await vscode.window.showQuickPick(items, {
      placeHolder: '연결할 항목을 선택하세요',
    });
    if (!chosen) return;
    const selected = cfg.connections.find((c: any) => c.id === (chosen as any).detail);
    if (!selected) return;

    let ok = false;
    if (selected.type === 'ADB') ok = (await adbGetState(selected.details.deviceID)) === 'device';
    else ok = await sshQuickCheck(selected.details);

    if (!ok) {
      vscode.window.showWarningMessage(
        '연결할 수 없습니다. 장치 상태 또는 인증(ID/Password)을 확인하세요.',
      );
      return;
    }

    // 1) persist
    markRecent(cfg, selected.id);
    await saveConnectionConfig(base, cfg);
    // 2) activate via ConnectionManager (단일 소스오브트루스)
    connectionManager.setActive(selected);
    // 3) optional health update (비동기)
    connectionManager.checkHealth().catch(() => {});
    vscode.window.showInformationMessage(
      `연결됨: ${selected.type} · ${selected.alias || selected.id} (활성화)`,
    );
  }

  private async _pickNew(base: string, cfg: any) {
    const branch = await vscode.window.showQuickPick(
      [{ label: 'ADB 연결' }, { label: 'SSH 연결' }],
      { placeHolder: '새 연결 방식을 선택하세요' },
    );
    if (!branch) return;
    if (branch.label.startsWith('ADB')) return this._newAdb(base, cfg);
    return this._newSsh(base, cfg);
  }

  private async _newAdb(base: string, cfg: any) {
    try {
      const list = await adbListDevices({});
      const candidates = list.filter((d) => d.state === 'device');
      if (candidates.length === 0) {
        vscode.window.showWarningMessage('연결 가능한 ADB 장치가 없습니다. (adb devices 확인)');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        candidates.map((d) => ({ label: d.id, description: 'ADB device' })),
        { placeHolder: 'ADB 장치를 선택하세요' },
      );
      if (!pick) return;
      const deviceID = pick.label;
      const alias = await vscode.window.showInputBox({
        prompt: '별칭(선택)',
        placeHolder: '예) Homey-Dev-01',
        ignoreFocusOut: true,
      });

      const entry: ConnectionInfo = {
        id: `adb:${deviceID}`,
        type: 'ADB',
        details: { deviceID },
        alias: alias || undefined,
        lastUsed: new Date().toISOString(),
      };
      upsertConnection(cfg, entry);
      await saveConnectionConfig(base, cfg);
      // 활성 연결로 설정
      connectionManager.setActive(entry);
      connectionManager.checkHealth().catch(() => {});
      vscode.window.showInformationMessage(`ADB 연결 항목 저장 및 활성화: ${alias || deviceID}`);
    } catch (e: any) {
      log.error('ADB list failed', e);
      vscode.window.showErrorMessage(`ADB 조회 실패: ${e?.message || e}`);
    }
  }

  private async _newSsh(base: string, cfg: any) {
    const host = await vscode.window.showInputBox({
      prompt: 'SSH Host',
      placeHolder: '예) 192.168.0.10 또는 homey.local',
      ignoreFocusOut: true,
    });
    if (!host) return;
    const user = await vscode.window.showInputBox({
      prompt: 'SSH User',
      placeHolder: '예) root',
      ignoreFocusOut: true,
    });
    if (!user) return;
    const portStr = await vscode.window.showInputBox({
      prompt: 'SSH Port',
      value: '22',
      ignoreFocusOut: true,
      validateInput(v) {
        const n = Number(v);
        return !Number.isInteger(n) || n < 1 || n > 65535 ? '1~65535 숫자' : undefined;
      },
    });
    if (!portStr) return;
    const port = Number(portStr);
    const password = await vscode.window.showInputBox({
      prompt: 'SSH Password',
      password: true,
      ignoreFocusOut: true,
      placeHolder: '개발용: 평문 저장(로컬) — 운영환경 금지',
    });
    if (password === undefined) return; // 취소
    const alias = await vscode.window.showInputBox({
      prompt: '별칭(선택)',
      placeHolder: '예) Homey-SSH',
      ignoreFocusOut: true,
    });

    const ok = await sshQuickCheck({ host, user, port, password, timeoutMs: 5000 });
    if (!ok) {
      vscode.window.showWarningMessage('SSH 접속 테스트 실패. ID/Password 및 방화벽을 확인하세요.');
      return;
    }

    const id = `ssh:${user}@${host}:${port}`;
    const entry: ConnectionInfo = {
      id,
      type: 'SSH',
      details: { host, user, port, password },
      alias: alias || undefined,
      lastUsed: new Date().toISOString(),
    };
    upsertConnection(cfg, entry);
    await saveConnectionConfig(base, cfg);
    // 활성 연결로 설정
    connectionManager.setActive(entry);
    connectionManager.checkHealth().catch(() => {});
    vscode.window.showInformationMessage(`SSH 연결 항목 저장 및 활성화: ${alias || id}`);
  }
}
