// src/core/controller/HostController.ts
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import { connectionManager } from '../connection/ConnectionManager.js';
import type { IConnectionManager, HostConfig } from '../connection/ConnectionManager.js';
import { getLogger } from '../logging/extension-logger.js';
import { measure } from '../logging/perf.js';
import { FileTransferService } from '../transfer/FileTransferService.js';

const log = getLogger('HostController');

export class HostController {
  constructor(private cm: IConnectionManager = connectionManager, private workspaceFs: string) {}

  // ── Utils ──────────────────────────────────────────────────
  private sq(s: string) {
    // POSIX single-quote safe: 'a'\''b'
    return String(s).replace(/'/g, `'\\''`);
  }
  private wrap(cmd: string) {
    // go 프로젝트와 동일하게: ADB에서는 -l 금지(로그인 쉘 이슈)
    const flat = cmd.replace(/\n/g, ' ').trim();
    const t = this.cm.getSnapshot()?.active?.type;
    if (t === 'ADB') return `sh -c '${this.sq(flat)}'`;        // ✅ ADB
    return `sh -lc '${this.sq(flat)}'`;                         // ✅ SSH
  }
  private normLocal(p: string) { return p.replace(/\\/g, '/'); }
  private async ensureLocalDir(dir: string) { await fsp.mkdir(dir, { recursive: true }); }

  // ── Remote Exec helpers ─────────────────────────────────────
  @measure()
  async execOut(cmd: string) {
    const wrapped = this.wrap(cmd);
    log.debug('[debug] execOut', { transport: this.cm.getSnapshot()?.active?.type, wrapped });
    const { code } = await this.cm.run(wrapped);
    return { code, stdout: '', stderr: '' };
  }

  @measure()
  async statType(absPath: string): Promise<'FILE' | 'DIR' | 'NONE'> {
    // -d 우선 → 나머지는 -e(파일/링크 포함)로 FILE 취급
    const script =
      `if [ -d "${absPath}" ]; then echo DIR; ` +
      `elif [ -e "${absPath}" ]; then echo FILE; else echo NONE; fi`;
    const wrapped = this.wrap(script);
    log.debug('[debug] statType: request', { path: absPath, transport: this.cm.getSnapshot()?.active?.type, wrapped });

    let kind: 'FILE'|'DIR'|'NONE' = 'NONE';
    await this.cm.stream(wrapped, (line) => {
      const t = String(line).trim();
      if (t === 'FILE' || t === 'DIR' || t === 'NONE') {
        kind = t;
        log.debug('[debug] statType: response', { path: absPath, kind: t });
      }
    });
    return kind;
  }

  @measure()
  async ensureDir(absPath: string) {
    const wrapped = this.wrap(`mkdir -p "${absPath}"`);
    log.debug('[debug] ensureDir', { absPath, wrapped });
    await this.cm.run(wrapped);
  }

  // Docker Root (eg. /lg_rw/var/lib/docker)
  @measure()
  async getDockerRoot(): Promise<string> {
    let root = '/lg_rw/var/lib/docker';
    const wrapped = this.wrap(`docker info -f "{{.DockerRootDir}}" 2>/dev/null || true`);
    log.debug('[debug] getDockerRoot: request', { wrapped });
    await this.cm.stream(wrapped, (line) => {
      const t = String(line).trim();
      if (t && t !== 'null') root = t;
    });
    log.debug('[debug] getDockerRoot: resolved', { root });
    return root;
  }

  @measure()
  async resolveHomeyPath(kind: 'pro'|'core'|'sdk'|'bridge'): Promise<string> {
    const dockerRoot = await this.getDockerRoot();
    let p: string;
    if (kind === 'pro')   p = path.posix.join(dockerRoot, 'volumes/homey-app/_data');
    else if (kind === 'core')  p = path.posix.join(dockerRoot, 'volumes/homey-node/_data/@athombv/homey-core/dist');
    else if (kind === 'sdk')   p = path.posix.join(dockerRoot, 'volumes/homey-node/_data/@athombv/homey-apps-sdk-v3');
    else /* bridge */          p = path.posix.join(dockerRoot, 'volumes/homey-node/_data/@athombv/homey-bridge');
    log.debug('[debug] resolveHomeyPath', { kind, path: p });
    return p;
  }

  // ── Path mapping: host <-> local(host_sync) ─────────────────
  toLocalFromHost(absHostPath: string): string {
    const rel = absHostPath.replace(/^[\\/]+/, '').replace(/\\/g, '/');
    const p = path.join(this.workspaceFs, 'host_sync', rel);
    log.debug('[debug] toLocalFromHost', { absHostPath, local: p });
    return p;
  }
  toHostFromLocalHostSync(localPath: string): string {
    const norm = localPath.replace(/\\/g, '/');
    const idx = norm.indexOf('/host_sync/');
    const host = idx >= 0 ? '/' + norm.substring(idx + '/host_sync/'.length) : '/' + norm.replace(/^\.?\/*/, '');
    log.debug('[debug] toHostFromLocalHostSync', { localPath, host });
    return host;
  }

  // ── Transfer hooks (tar|base64 단일 세션) ─
  private getHostConfigFromActive(): HostConfig {
    const active = this.cm.getSnapshot()?.active;
    if (!active) throw new Error('No active connection');
    if (active.type === 'ADB') {
      const serial = (active.details as any)?.deviceID;
      return { id: active.id, type: 'adb', serial, timeoutMs: 15000 };
    }
    const d = active.details as any;
    return { id: active.id, type: 'ssh', host: d.host, port: d.port, user: d.user, timeoutMs: 15000 };
  }
  private getFT(): FileTransferService { return new FileTransferService(this.getHostConfigFromActive()); }

  @measure()
  async pullFile(absHost: string, localFs: string) {
    await this.ensureLocalDir(path.dirname(localFs));
    const remoteDir = path.posix.dirname(absHost);
    const baseName = path.posix.basename(absHost);
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'edge-pull-'));
    log.debug('[debug] pullFile: plan', { absHost, localFs, remoteDir, baseName, tmp });
    try {
      await this.getFT().downloadViaTarBase64(remoteDir, tmp, { paths: [baseName] });
      const src = path.join(tmp, baseName);
      const buf = await fsp.readFile(src);
      await fsp.writeFile(localFs, buf);
      log.info(`[pullFile] ${absHost} -> ${localFs} (${buf.length} bytes)`);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }

  @measure()
  async pullDir(absHostDir: string, localDir: string) {
    await this.ensureLocalDir(localDir);
    log.debug('[debug] pullDir: plan', { absHostDir, localDir });
    await this.getFT().downloadViaTarBase64(absHostDir, localDir);
    log.info(`[pullDir] ${absHostDir} -> ${localDir}`);
  }

  @measure()
  async pushFile(localFs: string, absHost: string) {
    const remoteDir = path.posix.dirname(absHost);
    const baseName = path.posix.basename(absHost);
    const baseDir = path.dirname(localFs);
    log.debug('[debug] pushFile: plan', { localFs, absHost, baseDir, remoteDir, baseName });
    await this.getFT().uploadViaTarBase64(baseDir, remoteDir, { paths: [baseName] });
    log.info(`[pushFile] ${localFs} -> ${absHost}`);
  }

  @measure()
  async pushDir(localDir: string, absHostDir: string) {
    log.debug('[debug] pushDir: plan', { localDir, absHostDir });
    await this.getFT().uploadViaTarBase64(localDir, absHostDir);
    log.info(`[pushDir] ${localDir} -> ${absHostDir}`);
  }
}
