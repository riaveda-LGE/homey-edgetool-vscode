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
  homey_service_name?: string;      // 탐지된 유닛명 저장(선택)
};

export async function readUserHomeyConfig(
  ctx: vscode.ExtensionContext,
): Promise<HomeyUserConfig> {
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
  const base = (cfg.homey_service_file_path || '/lib/systemd/system/').replace(/\\+/g, '/');
  const name = cfg.homey_service_file_name || 'homey-pro@.service';
  return path.posix.join(base.endsWith('/') ? base : base + '/', name);
}