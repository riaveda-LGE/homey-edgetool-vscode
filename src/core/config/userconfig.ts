// === src/core/config/userconfig.ts ===
import * as path from 'path';
import * as vscode from 'vscode';

import { USERCFG_REL } from '../../shared/const.js';
import { getLogger } from '../logging/extension-logger.js';
import { measureBlock } from '../logging/perf.js';
import { resolveWorkspaceInfo } from './userdata.js';

const log = getLogger('userconfig');

export type HomeyUserConfig = {
  homey_service_file_path?: string; // 기본 /lib/systemd/system/
  homey_service_file_name?: string; // 기본 homey-pro@.service
  homey_service_name?: string; // 탐지된 유닛명 저장(선택)
};

export async function readUserHomeyConfig(ctx: vscode.ExtensionContext): Promise<HomeyUserConfig> {
  return measureBlock('usercfg.read', async () => {
    const info = await resolveWorkspaceInfo(ctx);
    const cfgUri = vscode.Uri.joinPath(info.wsDirUri, ...USERCFG_REL.split('/'));
    try {
      const buf = await vscode.workspace.fs.readFile(cfgUri);
      const json = JSON.parse(new TextDecoder('utf-8').decode(buf));
      return (json ?? {}) as HomeyUserConfig;
    } catch {
      return {};
    }
  });
}

/**
 * ctx 없이도 workspace 우선으로 사용자 설정을 읽는다.
 * edge-go 방식: "워크스페이스의 .config/custom_user_config.json"을 SSOT로 신뢰.
 * 실패 시 빈 객체 반환.
 */
export async function readUserHomeyConfigLoose(): Promise<HomeyUserConfig> {
  return measureBlock('usercfg.readLoose', async () => {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return {};
    const cfgUri = vscode.Uri.joinPath(ws.uri, ...USERCFG_REL.split('/'));
    try {
      const buf = await vscode.workspace.fs.readFile(cfgUri);
      const json = JSON.parse(new TextDecoder('utf-8').decode(buf));
      return (json ?? {}) as HomeyUserConfig;
    } catch {
      return {};
    }
  });
}

export async function writeUserHomeyConfig(
  ctx: vscode.ExtensionContext,
  patch: Partial<HomeyUserConfig>,
): Promise<void> {
  await measureBlock('usercfg.write', async () => {
    const info = await resolveWorkspaceInfo(ctx);
    const cfgUri = vscode.Uri.joinPath(info.wsDirUri, ...USERCFG_REL.split('/'));
    let cur: HomeyUserConfig = {};
    try {
      const buf = await vscode.workspace.fs.readFile(cfgUri);
      cur = JSON.parse(new TextDecoder('utf-8').decode(buf));
    } catch {}
    const next: HomeyUserConfig = { ...cur, ...(patch ?? {}) };
    const txt = JSON.stringify(next, null, 2);
    await vscode.workspace.fs.writeFile(cfgUri, new TextEncoder().encode(txt));
    log.info(`user config updated (${cfgUri.fsPath})`);
  });
}

export function resolveServiceFilePath(cfg: HomeyUserConfig): string {
  // 역슬래시 → 슬래시 정규화(윈도 경로 입력 보호)
  const base = (cfg.homey_service_file_path || '/lib/systemd/system/').replace(/\\/g, '/');
  const name = cfg.homey_service_file_name || 'homey-pro@.service';
  return path.posix.join(base.endsWith('/') ? base : base + '/', name);
}
