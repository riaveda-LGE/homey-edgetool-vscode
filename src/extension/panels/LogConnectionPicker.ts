// === src/extension/panels/LogConnectionPicker.ts ===
import * as vscode from 'vscode';

import {
  addDevice,
  type DeviceEntry,
  readDeviceList,
  updateDeviceById,
} from '../../core/config/userdata.js';
import type { HostConfig } from '../../core/connection/ConnectionManager.js';
import { DEFAULT_SSH_PORT, MAX_SSH_PORT, MIN_SSH_PORT } from '../../shared/const.js';
import { promptNumber, promptText } from '../../shared/ui-input.js';

export class LogConnectionPicker {
  constructor(private _context: vscode.ExtensionContext) {}

  async pickConnection(): Promise<HostConfig | undefined> {
    const list = await readDeviceList(this._context);

    const deviceItems = list.map((d) => {
      const label =
        d.type === 'ssh'
          ? `SSH  ${d.host ?? ''}${d.port ? ':' + d.port : ''}${(d as any).user ? ` (${(d as any).user})` : ''}`
          : `ADB  ${(d as any).serial ?? d.id ?? ''}`;
      const desc = d.name || d.id || '';
      return {
        label,
        description: desc,
        detail:
          d.type === 'ssh'
            ? `${d.host ?? ''} ${(d as any).user ?? ''}`
            : `${(d as any).serial ?? ''}`,
        device: d,
        alwaysShow: true,
      } as vscode.QuickPickItem & { device: DeviceEntry };
    });

    const addItems: (vscode.QuickPickItem & { __action: 'add-ssh' | 'add-adb' })[] = [
      { label: '새 연결 추가 (SSH)', description: 'host/user/port 입력', __action: 'add-ssh' },
      { label: '새 연결 추가 (ADB)', description: 'serial 입력', __action: 'add-adb' },
    ];

    const pick = await vscode.window.showQuickPick([...deviceItems, ...addItems], {
      placeHolder:
        deviceItems.length > 0
          ? '최근 연결을 선택하거나, 새 연결을 추가하세요'
          : '저장된 연결이 없습니다. 새 연결을 추가하세요',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!pick) return;

    if ((pick as any).device) {
      const d = (pick as any).device as DeviceEntry;
      return deviceEntryToHostConfig(d);
    }

    if ((pick as any).__action === 'add-ssh') {
      return await this.addSshConnection(list);
    }

    if ((pick as any).__action === 'add-adb') {
      return await this.addAdbConnection(list);
    }

    return;
  }

  private async addSshConnection(list: DeviceEntry[]): Promise<HostConfig | undefined> {
    const host = await promptText({
      prompt: 'SSH Host (예: 192.168.0.10)',
      placeHolder: '호스트/IP',
      validateInput: (v) => (!v ? '필수 입력' : undefined),
    });
    if (!host) return;

    const user = await promptText({
      prompt: 'SSH User (예: root)',
      placeHolder: '사용자',
      validateInput: (v) => (!v ? '필수 입력' : undefined),
    });
    if (!user) return;

    const port = await promptNumber({
      prompt: 'SSH Port (기본 22)',
      placeHolder: '22',
      min: MIN_SSH_PORT,
      max: MAX_SSH_PORT,
    });

    const friendly = await promptText({
      prompt: '표시 이름(선택)',
      placeHolder: '예: 사무실-Homey SSH',
    });

    const id = `${host}:${port ?? DEFAULT_SSH_PORT}`;
    const entry: DeviceEntry = { id, type: 'ssh', name: friendly?.trim() || id, host, port, user };

    const exist = list.find((x) => (x.id ?? '') === id);
    if (exist) await updateDeviceById(this._context, id, entry);
    else await addDevice(this._context, entry);

    return { id, type: 'ssh', host, port, user } as HostConfig;
  }

  private async addAdbConnection(list: DeviceEntry[]): Promise<HostConfig | undefined> {
    const serial = await promptText({
      prompt: 'ADB Serial (adb devices 로 확인 가능)',
      placeHolder: 'device-serial',
      validateInput: (v) => (!v ? '필수 입력' : undefined),
    });
    if (!serial) return;

    const friendly = await promptText({
      prompt: '표시 이름(선택)',
      placeHolder: '예: 개발-Homey ADB',
    });

    const id = serial;
    const entry: DeviceEntry = { id, type: 'adb', name: friendly?.trim() || id, serial };

    const exist = list.find((x) => (x.id ?? '') === id);
    if (exist) await updateDeviceById(this._context, id, entry);
    else await addDevice(this._context, entry);

    return { id, type: 'adb', serial } as HostConfig;
  }
}

function deviceEntryToHostConfig(d: DeviceEntry): HostConfig {
  if (d.type === 'ssh') {
    const id = d.id ?? `${d.host ?? ''}:${d.port ?? DEFAULT_SSH_PORT}`;
    return {
      id,
      type: 'ssh',
      host: String(d.host ?? ''),
      port: typeof d.port === 'number' ? d.port : DEFAULT_SSH_PORT,
      user: String((d as any).user ?? 'root'),
    };
  }
  return {
    id: d.id ?? String((d as any).serial ?? ''),
    type: 'adb',
    serial: String((d as any).serial ?? d.id ?? ''),
  };
}
