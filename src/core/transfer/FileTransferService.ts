import { DEFAULT_TRANSFER_TIMEOUT_MS } from '../../shared/const.js';
import { ErrorCategory, XError } from '../../shared/errors.js';
import type { HostConfig } from '../connection/ConnectionManager.js';
import { runCommandLine } from '../connection/ExecRunner.js';
import { getLogger } from '../logging/extension-logger.js';
import { measure } from '../logging/perf.js';

export type TransferOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export interface IFileTransferService {
  uploadViaTarBase64(
    localDir: string,
    remoteDir: string,
    opts?: TransferOptions & { paths?: string[] }, // 상대경로 목록(선택)
  ): Promise<void>;
  downloadViaTarBase64(
    remoteDir: string,
    localDir: string,
    opts?: TransferOptions & { paths?: string[] }, // 상대경로 목록(선택)
  ): Promise<void>;
}

export class FileTransferService implements IFileTransferService {
  private log = getLogger('FileTransfer');
  constructor(private target: HostConfig) {}

  @measure()
  async uploadViaTarBase64(
    localDir: string,
    remoteDir: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal; paths?: string[] },
  ) {
    this.log.debug('[debug] FileTransferService uploadViaTarBase64: start');
    try {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
      // tar 대상으로: 지정 경로가 있으면 그 목록, 없으면 . (전체)
      const list =
        opts?.paths && opts.paths.length ? opts.paths.map((p) => `'${escapeQ(p)}'`).join(' ') : '.';

      if (this.target.type === 'ssh') {
        const ssh = buildSshPrefix(this.target);
        const cmd = `tar -C "${localDir}" -cf - ${list} | base64 | ${ssh} "mkdir -p '${escapeQ(remoteDir)}' && base64 -d | tar -C '${escapeQ(remoteDir)}' -xpf -"`;
        this.log.info(
          `upload ssh: ${localDir} -> ${this.target.user}@${this.target.host}:${remoteDir}`,
        );
        await runCommandLine(cmd, { timeoutMs, signal: opts?.signal });
        this.log.debug('[debug] FileTransferService uploadViaTarBase64: end');
        return;
      }
      // adb
      const serial = this.target.serial ? `-s ${this.target.serial}` : '';
      const cmd = `tar -C "${localDir}" -cf - ${list} | base64 | adb ${serial} shell "mkdir -p '${escapeQ(remoteDir)}' && base64 -d | tar -C '${escapeQ(remoteDir)}' -xpf -"`;
      this.log.info(`upload adb: ${localDir} -> device:${this.target.serial ?? ''} ${remoteDir}`);
      await runCommandLine(cmd, { timeoutMs, signal: opts?.signal });
      this.log.debug('[debug] FileTransferService uploadViaTarBase64: end');
    } catch (e) {
      throw new XError(
        ErrorCategory.Connection,
        `Upload failed: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }
  }

  @measure()
  async downloadViaTarBase64(
    remoteDir: string,
    localDir: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal; paths?: string[] },
  ) {
    this.log.debug('[debug] FileTransferService downloadViaTarBase64: start');
    try {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
      // tar 대상으로: 지정 경로가 있으면 그 목록, 없으면 . (전체)
      const list =
        opts?.paths && opts.paths.length ? opts.paths.map((p) => `'${escapeQ(p)}'`).join(' ') : '.';

      if (this.target.type === 'ssh') {
        const ssh = buildSshPrefix(this.target);
        const cmd = `${ssh} "tar -C '${escapeQ(remoteDir)}' -cf - ${list} | base64" | base64 -d | tar -C "${localDir}" -xpf -`;
        this.log.info(
          `download ssh: ${this.target.user}@${this.target.host}:${remoteDir} -> ${localDir}`,
        );
        await runCommandLine(cmd, { timeoutMs, signal: opts?.signal });
        this.log.debug('[debug] FileTransferService downloadViaTarBase64: end');
        return;
      }
      // adb
      const serial = this.target.serial ? `-s ${this.target.serial}` : '';
      const cmd = `adb ${serial} shell "tar -C '${escapeQ(remoteDir)}' -cf - ${list} | base64" | base64 -d | tar -C "${localDir}" -xpf -`;
      this.log.info(`download adb: device:${this.target.serial ?? ''} ${remoteDir} -> ${localDir}`);
      await runCommandLine(cmd, { timeoutMs, signal: opts?.signal });
      this.log.debug('[debug] FileTransferService downloadViaTarBase64: end');
    } catch (e) {
      throw new XError(
        ErrorCategory.Connection,
        `Download failed: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }
  }
}

function buildSshPrefix(c: Extract<HostConfig, { type: 'ssh' }>) {
  const port = c.port ? `-p ${c.port}` : '';
  const key = c.keyPath ? `-i "${c.keyPath}"` : '';
  // BatchMode=yes ⇒ 비밀번호 입력 없이 실패(키 권장). 필요 시 후속 단계에서 옵션 분기.
  const opt = '-o StrictHostKeyChecking=no -o BatchMode=yes';
  const host = `${c.user}@${c.host}`;
  return `ssh ${port} ${key} ${opt} ${host}`;
}

function escapeQ(s: string) {
  return s.replace(/'/g, `'\\''`);
}
