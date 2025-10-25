// === src/core/connection/sshClient.ts ===
import { runCommandLine } from './ExecRunner.js';
import { getLogger } from '../logging/extension-logger.js';
import { measureBlock } from '../logging/perf.js';

export type SshOptions = {
  host: string;
  port?: number;
  user?: string;
  keyPath?: string;
  password?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const log = getLogger('ssh');

function buildSshPrefix(opts: SshOptions): string {
  log.debug('[debug] buildSshPrefix: start');
  const host = `${opts.user ? `${opts.user}@` : ''}${opts.host}`;
  const port = opts.port ? `-p ${opts.port}` : '';
  const key = opts.keyPath ? `-i "${opts.keyPath}"` : '';
  const opt = '-o StrictHostKeyChecking=no -o BatchMode=yes';
  const result = `ssh ${port} ${key} ${opt} ${host}`;
  log.debug('[debug] buildSshPrefix: end');
  return result;
}

export async function sshRun(cmd: string, opts: SshOptions): Promise<number | null> {
  return measureBlock('ssh.sshRun', async () => {
    log.debug('[debug] sshRun: start');
    const full = `${buildSshPrefix(opts)} "${cmd.replace(/"/g, '\\"')}"`;
    log.debug('sshRun', full);
    const { code } = await runCommandLine(full, {
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onStdout: (b) => process.stdout.write(b),
      onStderr: (b) => process.stderr.write(b),
    });
    log.debug('[debug] sshRun: end');
    return code;
  });
}

export async function sshStream(cmd: string, opts: SshOptions, onLine: (line: string) => void) {
  return measureBlock('ssh.sshStream', async () => {
    log.debug('[debug] sshStream: start');
    const full = `${buildSshPrefix(opts)} "${cmd.replace(/"/g, '\\"')}"`;
    let residual = '';
    await runCommandLine(full, {
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onStdout: (b) => {
        const all = residual + b.toString('utf8');
        const parts = all.split(/\r?\n/);
        residual = parts.pop() ?? '';
        for (const p of parts) onLine(p);
      },
      onStderr: (b) => process.stderr.write(b),
    });
    log.debug('[debug] sshStream: end');
  });
}
