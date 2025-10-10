// === src/core/config/userdata.ts ===
import * as vscode from 'vscode';
import * as path from 'path';

export type Json = any;

/** 확장 전역 사용자 설정 (config.json) */
export type AppConfigFile = {
  /** 사용자가 지정한 절대 기반 경로. 실제 워크스페이스는 <workspace_dir>/workspace 를 사용 */
  workspace_dir?: string;
  /** 그 외 확장 전역 설정 값들 */
  [k: string]: Json | undefined;
};

/** 연결된 기기 목록 (connect_device_list.json) */
export type DeviceEntry = {
  id?: string;
  name?: string;
  host?: string;
  port?: number;
  type?: 'ssh' | 'adb' | string;
  [k: string]: Json | undefined;
};
export type DeviceListFile = DeviceEntry[]; // 단순 배열로 관리

const FILE_CONFIG = 'config.json';
const FILE_DEVICES = 'connect_device_list.json';
const DIR_WORKSPACE = 'workspace';

export type UserdataPaths = {
  storageDir: vscode.Uri;           // 확장 전용 폴더 (globalStorage)
  configJson: vscode.Uri;           // <storageDir>/config.json
  deviceListJson: vscode.Uri;       // <storageDir>/connect_device_list.json
  defaultWorkspaceDir: vscode.Uri;  // <storageDir>/workspace
};

export function getUserdataPaths(ctx: vscode.ExtensionContext): UserdataPaths {
  const storageDir = ctx.globalStorageUri;
  return {
    storageDir,
    configJson: vscode.Uri.joinPath(storageDir, FILE_CONFIG),
    deviceListJson: vscode.Uri.joinPath(storageDir, FILE_DEVICES),
    defaultWorkspaceDir: vscode.Uri.joinPath(storageDir, DIR_WORKSPACE),
  };
}

/** 디렉터리 보장 */
export async function ensureDir(uri: vscode.Uri) {
  await vscode.workspace.fs.createDirectory(uri);
}

/** JSON 읽기 (없으면 undefined) */
export async function readJson<T = any>(uri: vscode.Uri): Promise<T | undefined> {
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    const txt = new TextDecoder('utf8').decode(buf);
    return JSON.parse(txt) as T;
  } catch {
    return undefined;
  }
}

/** JSON 쓰기 (pretty) */
export async function writeJson(uri: vscode.Uri, obj: any) {
  const txt = JSON.stringify(obj ?? {}, null, 2);
  const buf = new TextEncoder().encode(txt);
  await vscode.workspace.fs.writeFile(uri, buf);
}

/** 워크스페이스 정보 */
export type WorkspaceInfo = {
  /** 베이스 디렉터리(사용자 지정이면 그 경로, 아니면 확장전용폴더) */
  baseDirFsPath: string;
  /** 실제 사용하는 workspace 디렉터리 */
  wsDirFsPath: string;
  /** 구성 소스: 'user' | 'default' */
  source: 'user' | 'default';
  /** 각 경로의 URI */
  baseDirUri: vscode.Uri;
  wsDirUri: vscode.Uri;
};

/**
 * 현재 config 기준의 워크스페이스 정보를 계산하고,
 * 실제 사용하는 폴더(<base>/workspace 또는 <storageDir>/workspace)를 보장해 반환한다.
 */
export async function resolveWorkspaceInfo(ctx: vscode.ExtensionContext): Promise<WorkspaceInfo> {
  const paths = getUserdataPaths(ctx);
  await ensureDir(paths.storageDir);

  const cfg = (await readJson<AppConfigFile>(paths.configJson)) ?? {};
  const base = cfg.workspace_dir?.trim();

  if (base && path.isAbsolute(base)) {
    const baseDirUri = vscode.Uri.file(base);
    const wsDirUri = vscode.Uri.file(path.join(base, DIR_WORKSPACE));
    await ensureDir(baseDirUri);
    await ensureDir(wsDirUri);
    return {
      baseDirFsPath: baseDirUri.fsPath,
      wsDirFsPath: wsDirUri.fsPath,
      source: 'user',
      baseDirUri,
      wsDirUri,
    };
  }

  // default: 확장전용폴더를 베이스로 보고, 그 아래 <storageDir>/workspace 사용
  await ensureDir(paths.storageDir);
  await ensureDir(paths.defaultWorkspaceDir);
  return {
    baseDirFsPath: paths.storageDir.fsPath,
    wsDirFsPath: paths.defaultWorkspaceDir.fsPath,
    source: 'default',
    baseDirUri: paths.storageDir,
    wsDirUri: paths.defaultWorkspaceDir,
  };
}

/** 이전 API 유지: 실제 workspace 디렉터리 URI만 필요할 때 */
export async function resolveAndEnsureWorkspaceDir(ctx: vscode.ExtensionContext): Promise<vscode.Uri> {
  const info = await resolveWorkspaceInfo(ctx);
  return info.wsDirUri;
}

/** 워크스페이스 베이스(절대 경로)를 변경하고 config.json을 업데이트. 실제 사용은 <base>/workspace */
export async function changeWorkspaceBaseDir(
  ctx: vscode.ExtensionContext,
  absoluteBaseDir: string,
): Promise<WorkspaceInfo> {
  if (!absoluteBaseDir || !path.isAbsolute(absoluteBaseDir)) {
    throw new Error('절대 경로를 입력해야 합니다.');
  }
  const paths = getUserdataPaths(ctx);
  await ensureDir(paths.storageDir);

  const cfg = (await readJson<AppConfigFile>(paths.configJson)) ?? {};
  cfg.workspace_dir = absoluteBaseDir;
  await writeJson(paths.configJson, cfg);

  return await resolveWorkspaceInfo(ctx);
}

/** (편의) 현재 워크스페이스 경로 문자열 */
export async function getCurrentWorkspacePathFs(ctx: vscode.ExtensionContext): Promise<string> {
  const info = await resolveWorkspaceInfo(ctx);
  return info.wsDirFsPath;
}

/* -------------------- Device List Helpers -------------------- */

/** 장치 목록 읽기 (없으면 빈 배열) */
export async function readDeviceList(ctx: vscode.ExtensionContext): Promise<DeviceListFile> {
  const { storageDir, deviceListJson } = getUserdataPaths(ctx);
  await ensureDir(storageDir);
  return (await readJson<DeviceListFile>(deviceListJson)) ?? [];
}

/** 장치 목록 통째로 덮어쓰기 */
export async function writeDeviceList(ctx: vscode.ExtensionContext, list: DeviceListFile): Promise<void> {
  const { storageDir, deviceListJson } = getUserdataPaths(ctx);
  await ensureDir(storageDir);
  await writeJson(deviceListJson, Array.isArray(list) ? list : []);
}

/** 장치 추가(append) */
export async function addDevice(ctx: vscode.ExtensionContext, entry: DeviceEntry): Promise<void> {
  const list = await readDeviceList(ctx);
  list.push(entry);
  await writeDeviceList(ctx, list);
}

/** id 일치 항목 제거 */
export async function removeDeviceById(ctx: vscode.ExtensionContext, id: string): Promise<void> {
  const list = await readDeviceList(ctx);
  const filtered = list.filter(d => (d.id ?? '') !== id);
  await writeDeviceList(ctx, filtered);
}

/** id 일치 항목 업데이트(없으면 무시) */
export async function updateDeviceById(ctx: vscode.ExtensionContext, id: string, patch: Partial<DeviceEntry>): Promise<void> {
  const list = await readDeviceList(ctx);
  const idx = list.findIndex(d => (d.id ?? '') === id);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...patch };
    await writeDeviceList(ctx, list);
  }
}
