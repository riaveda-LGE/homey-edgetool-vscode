// === src/core/connection/adbClient.ts ===
import { getLogger } from '../logging/extension-logger.js';
import { measureBlock } from '../logging/perf.js';
import { runCommandLine } from './ExecRunner.js';

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


// ─────────────────────────────────────────────────────────────
// 추가: 연결 후보 탐색 / 헬스체크(경량)
// ─────────────────────────────────────────────────────────────
export type AdbDevice = { id: string; state: 'device' | 'unauthorized' | 'offline' | string };

export async function listDevices(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<AdbDevice[]> {
  let out = '';
  await runCommandLine('adb devices', {
    timeoutMs: opts?.timeoutMs,
    signal: opts?.signal,
    onStdout: (b) => { out += b.toString('utf8'); },
  });
  const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const devices: AdbDevice[] = [];
  for (const line of lines) {
    if (line.startsWith('List of devices')) continue;
    const [id, state] = line.split(/\s+/);
    if (id) devices.push({ id, state: (state as any) || 'unknown' });
  }
  return devices;
}

export async function getState(serial: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<string> {
  let out = '';
  await runCommandLine(`adb -s ${serial} get-state`, {
    timeoutMs: opts?.timeoutMs,
    signal: opts?.signal,
    onStdout: (b) => { out += b.toString('utf8'); },
  });
  return out.trim();
}