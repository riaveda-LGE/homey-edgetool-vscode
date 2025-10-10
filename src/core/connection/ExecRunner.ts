// === src/core/connection/ExecRunner.ts ===
import { spawn } from 'child_process';
import { getLogger } from '../logging/extension-logger.js';

export type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (buf: Buffer) => void;
  onStderr?: (buf: Buffer) => void;
  shell?: 'powershell' | 'sh';
};

const log = getLogger('ExecRunner');

export function runCommandLine(cmd: string, opts: ExecOptions = {}): Promise<{ code: number | null }> {
  const isWin = process.platform === 'win32';
  const shell = opts.shell ?? (isWin ? 'powershell' : 'sh');
  const sh = isWin ? 'powershell.exe' : '/bin/sh';
  const args = isWin ? ['-NoLogo', '-NoProfile', '-Command', cmd] : ['-c', cmd];

  return new Promise((resolve, reject) => {
    const child = spawn(sh, args, { cwd: opts.cwd, env: opts.env });

    const killAll = (reason?: string) => {
      try { child.kill('SIGTERM'); } catch {}
      if (reason) log.warn('killed sub process:', reason);
    };

    const onAbort = () => killAll('aborted');
    opts.signal?.addEventListener('abort', onAbort);

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => killAll('timeout'), opts.timeoutMs);
    }

    child.stdout.on('data', (b) => opts.onStdout?.(b));
    child.stderr.on('data', (b) => opts.onStderr?.(b));

    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code });
    });
  });
}
