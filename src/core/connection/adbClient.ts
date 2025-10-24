// === src/core/connection/adbClient.ts ===
import { runCommandLine } from './ExecRunner.js';
import { getLogger } from '../logging/extension-logger.js';
import { measureBlock } from '../logging/perf.js';

const log = getLogger('adb');

export type AdbOptions = { serial?: string; timeoutMs?: number; signal?: AbortSignal };

function prefix(opts: AdbOptions) {
  log.debug('[debug] prefix: start');
  const result = opts.serial ? `adb -s ${opts.serial}` : 'adb';
  log.debug('[debug] prefix: end');
  return result;
}

export async function adbShell(cmd: string, opts: AdbOptions) {
  return measureBlock('adb.adbShell', async () => {
    log.debug('[debug] adbShell: start');
    const full = `${prefix(opts)} shell "${cmd.replace(/"/g, '\\"')}"`;
    log.debug('adbShell', full);
    const r = await runCommandLine(full, {
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onStdout: (b) => process.stdout.write(b),
      onStderr: (b) => process.stderr.write(b),
    });
    log.debug('[debug] adbShell: end');
    return r;
  });
}

export async function adbStream(cmd: string, opts: AdbOptions, onLine: (line: string) => void) {
  return measureBlock('adb.adbStream', async () => {
    log.debug('[debug] adbStream: start');
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
    log.debug('[debug] adbStream: end');
  });
}
