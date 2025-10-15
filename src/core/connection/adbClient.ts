// === src/adapters/adb/adbClient.ts ===
import { runCommandLine } from '../../core/connection/ExecRunner.js';
import { getLogger } from '../logging/extension-logger.js';

const log = getLogger('adb');

export type AdbOptions = { serial?: string; timeoutMs?: number; signal?: AbortSignal };

function prefix(opts: AdbOptions) {
  return opts.serial ? `adb -s ${opts.serial}` : 'adb';
}

export async function adbShell(cmd: string, opts: AdbOptions) {
  const full = `${prefix(opts)} shell "${cmd.replace(/"/g, '\\"')}"`;
  log.debug('adbShell', full);
  return runCommandLine(full, {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onStdout: (b) => process.stdout.write(b),
    onStderr: (b) => process.stderr.write(b),
  });
}

export async function adbStream(cmd: string, opts: AdbOptions, onLine: (line: string) => void) {
  const full = `${prefix(opts)} shell "${cmd.replace(/"/g, '\\"')}"`;
  log.debug('adbStream', full);
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
}
