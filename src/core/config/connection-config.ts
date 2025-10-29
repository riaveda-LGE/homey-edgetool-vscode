// === src/core/config/connection-config.ts ===
import * as fs from 'fs';
import * as path from 'path';

export type ConnectionType = 'ADB' | 'SSH';

export interface AdbDetails {
  deviceID: string;
}

export interface SshDetails {
  host: string;
  user: string;
  port: number;
  /** DEV 전용: 평문 저장. 보안 환경에선 저장 금지 또는 외부 시크릿으로 대체 권장 */
  password?: string;
}

export interface ConnectionInfo {
  id: string; // e.g. "adb:<serial>" or "ssh:<user>@<host>:<port>"
  alias?: string;
  type: ConnectionType;
  details: AdbDetails | SshDetails;
  lastUsed: string; // ISO string
}

export interface ConnectionConfigFile {
  recent?: string; // id of last used
  connections: ConnectionInfo[];
  defaultLoggingConfig?: {
    configured?: boolean;
    log_types?: string[];
    log_sources?: Record<string, string>;
  };
}

const CONFIG_DIR = '.config';
const CONFIG_FILE = 'connection_config.json';
const MAX_CONNECTIONS = 5;

export function getConfigFilePath(workspacePath: string): string {
  return path.join(workspacePath, CONFIG_DIR, CONFIG_FILE);
}

export function ensureConfigDir(workspacePath: string): void {
  const dir = path.join(workspacePath, CONFIG_DIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export async function readConnectionConfig(workspacePath: string): Promise<ConnectionConfigFile> {
  ensureConfigDir(workspacePath);
  const filePath = getConfigFilePath(workspacePath);
  if (!fs.existsSync(filePath)) {
    const fresh: ConnectionConfigFile = { connections: [] };
    await fs.promises.writeFile(filePath, JSON.stringify(fresh, null, 2), 'utf8');
    return fresh;
  }
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as ConnectionConfigFile;
    if (!parsed.connections) parsed.connections = [];
    return parsed;
  } catch {
    // fallback to empty on parse error
    const fresh: ConnectionConfigFile = { connections: [] };
    await fs.promises.writeFile(filePath, JSON.stringify(fresh, null, 2), 'utf8');
    return fresh;
  }
}

export async function saveConnectionConfig(
  workspacePath: string,
  cfg: ConnectionConfigFile,
): Promise<void> {
  ensureConfigDir(workspacePath);
  const filePath = getConfigFilePath(workspacePath);
  await fs.promises.writeFile(filePath, JSON.stringify(cfg, null, 2), 'utf8');
}

export function upsertConnection(
  cfg: ConnectionConfigFile,
  entry: ConnectionInfo,
): ConnectionConfigFile {
  const existingIdx = cfg.connections.findIndex((c) => c.id === entry.id);
  if (existingIdx >= 0) {
    // Update fields but keep id/type
    const prev = cfg.connections[existingIdx];
    cfg.connections[existingIdx] = { ...prev, ...entry, id: prev.id, type: prev.type };
  } else {
    cfg.connections.unshift(entry);
  }
  // sort by lastUsed desc
  cfg.connections.sort((a, b) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime());
  // cap size
  if (cfg.connections.length > MAX_CONNECTIONS) {
    cfg.connections = cfg.connections.slice(0, MAX_CONNECTIONS);
  }
  cfg.recent = entry.id;
  return cfg;
}

export function markRecent(cfg: ConnectionConfigFile, id: string): ConnectionConfigFile {
  const idx = cfg.connections.findIndex((c) => c.id === id);
  if (idx >= 0) {
    cfg.connections[idx].lastUsed = new Date().toISOString();
    cfg.recent = id;
    // keep recency order
    cfg.connections.sort((a, b) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime());
  }
  return cfg;
}
