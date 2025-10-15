import type { HostConfig } from '../connection/ConnectionManager.js';
import { runCommandLine } from '../connection/ExecRunner.js';
import { getLogger } from '../logging/extension-logger.js';
import { DEFAULT_TRANSFER_TIMEOUT_MS } from '../../shared/const.js';
import { XError, ErrorCategory } from '../../shared/errors.js';
import { measureIO } from '../logging/perf.js';

export type TransferOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export interface IFileTransferService {
  uploadViaTarBase64(localDir: string, remoteDir: string, opts?: TransferOptions): Promise<void>;
  downloadViaTarBase64(remoteDir: string, localDir: string, opts?: TransferOptions): Promise<void>;
}

export class FileTransferService implements IFileTransferService {
  private log = getLogger('FileTransfer');
  constructor(private target: HostConfig) {}

  @measureIO('upload', (instance) => instance.target.id)
  async uploadViaTarBase64(
    localDir: string,
    remoteDir: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ) {
    try {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
      if (this.target.type === 'ssh') {
        const ssh = buildSshPrefix(this.target);
        const cmd = `tar -C "${localDir}" -cf - . | base64 | ${ssh} "mkdir -p '${escapeQ(remoteDir)}' && base64 -d | tar -C '${escapeQ(remoteDir)}' -xpf -"`;
        this.log.info(
          `upload ssh: ${localDir} -> ${this.target.user}@${this.target.host}:${remoteDir}`,
        );
        await runCommandLine(cmd, { timeoutMs, signal: opts?.signal });
        return;
      }
      // adb
      const serial = this.target.serial ? `-s ${this.target.serial}` : '';
      const cmd = `tar -C "${localDir}" -cf - . | base64 | adb ${serial} shell "mkdir -p '${escapeQ(remoteDir)}' && base64 -d | tar -C '${escapeQ(remoteDir)}' -xpf -"`;
      this.log.info(`upload adb: ${localDir} -> device:${this.target.serial ?? ''} ${remoteDir}`);
      await runCommandLine(cmd, { timeoutMs, signal: opts?.signal });
    } catch (e) {
      throw new XError(ErrorCategory.Connection, `Upload failed: ${e instanceof Error ? e.message : String(e)}`, e);
    }
  }

  @measureIO('download', (instance) => instance.target.id)
  async downloadViaTarBase64(
    remoteDir: string,
    localDir: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ) {
    try {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
      if (this.target.type === 'ssh') {
        const ssh = buildSshPrefix(this.target);
        const cmd = `${ssh} "tar -C '${escapeQ(remoteDir)}' -cf - . | base64" | base64 -d | tar -C "${localDir}" -xpf -`;
        this.log.info(
          `download ssh: ${this.target.user}@${this.target.host}:${remoteDir} -> ${localDir}`,
        );
        await runCommandLine(cmd, { timeoutMs, signal: opts?.signal });
        return;
      }
      // adb
      const serial = this.target.serial ? `-s ${this.target.serial}` : '';
      const cmd = `adb ${serial} shell "tar -C '${escapeQ(remoteDir)}' -cf - . | base64" | base64 -d | tar -C "${localDir}" -xpf -`;
      this.log.info(`download adb: device:${this.target.serial ?? ''} ${remoteDir} -> ${localDir}`);
      await runCommandLine(cmd, { timeoutMs, signal: opts?.signal });
    } catch (e) {
      throw new XError(ErrorCategory.Connection, `Download failed: ${e instanceof Error ? e.message : String(e)}`, e);
    }
  }
}

function buildSshPrefix(c: Extract<HostConfig, { type: 'ssh' }>) {
  const port = c.port ? `-p ${c.port}` : '';
  const key = c.keyPath ? `-i "${c.keyPath}"` : '';
  const opt = '-o StrictHostKeyChecking=no -o BatchMode=yes';
  const host = `${c.user}@${c.host}`;
  return `ssh ${port} ${key} ${opt} ${host}`;
}

function escapeQ(s: string) {
  return s.replace(/'/g, `'\\''`);
}
