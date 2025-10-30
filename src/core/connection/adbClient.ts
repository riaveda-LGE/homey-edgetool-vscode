// === src/core/connection/adbClient.ts ===
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import adbkitPkg from '@devicefarmer/adbkit';
import { getLogger } from '../logging/extension-logger.js';
import { measureBlock } from '../logging/perf.js';

const log = getLogger('adb');

export type AdbOptions = { serial?: string; timeoutMs?: number; signal?: AbortSignal };

// ─────────────────────────────────────────────────────────────
// adbkit 인터롭(CJS/ESM) + v3 API(getDevice(...)) 타입
// ─────────────────────────────────────────────────────────────
type ADBDevice = {
  shell(command: string): Promise<NodeJS.ReadableStream>;
  pull(remotePath: string): Promise<NodeJS.ReadableStream>;
  push(
    src: NodeJS.ReadableStream,
    remotePath: string,
  ): Promise<NodeJS.ReadWriteStream & NodeJS.EventEmitter>;
};
type ADBClient = {
  listDevices(): Promise<Array<{ id: string; type?: string; state?: string }>>;
  getDevice(serial: string): ADBDevice;
};
const adbkit: { createClient: () => ADBClient } =
  ((adbkitPkg as any).default ?? (adbkitPkg as any));

// 모든 데이터를 버퍼로 읽기
function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (b: Buffer | string) =>
      chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(b)),
    );
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// ─────────────────────────────────────────────────────────────
// adbkit 클라이언트 (lazy singleton)
// ─────────────────────────────────────────────────────────────
let _client: ADBClient | null = null;
function client(): ADBClient {
  if (!_client) _client = adbkit.createClient();
  return _client;
}

async function resolveSerial(opts?: AdbOptions): Promise<string> {
  if (opts?.serial) return opts.serial;
  const list = await client().listDevices();
  // v3는 d.type 또는 d.state 로 들어올 수 있음
  const online = list.filter((d) => (d.type ?? d.state) === 'device');
  if (online.length === 1) return online[0].id;
  if (online.length === 0) throw new Error('No ADB devices in "device" state');
  throw new Error('Multiple ADB devices connected — specify serial');
}

// cmd 끝에 종료코드를 트레일러로 찍어 회수
function wrapWithExitCode(cmd: string): string {
  const flat = cmd.replace(/\r/g, '').replace(/\n/g, ' ').trim();
  const trailer = `; printf "\\n__EDGE_CODE:%d" $?`;
  if (/^\s*sh\s+-l?c\s+['"]/.test(flat)) {
    return `${flat}${trailer}`;
  }
  return `sh -c '${flat.replace(/'/g, `'\\''`)}${trailer}'`;
}

function installAbortAndTimeout(
  stream: NodeJS.ReadableStream,
  opts?: AdbOptions,
  onTimeout?: () => void,
) {
  let timer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    try {
      (stream as any).destroy?.(new Error('aborted'));
    } catch {}
  };
  if (opts?.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
  if (opts?.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      onTimeout?.();
      try {
        (stream as any).destroy?.(new Error('timeout'));
      } catch {}
    }, opts.timeoutMs);
  }
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (opts?.signal) opts.signal.removeEventListener('abort', onAbort);
  };
  stream.on('close', cleanup);
  stream.on('end', cleanup);
}

export async function adbShell(
  cmd: string,
  opts: AdbOptions,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return measureBlock('adb.adbShell', async () => {
    log.debug('[debug] adbShell(adbkit): start');
    const serial = await resolveSerial(opts);
    const composed = wrapWithExitCode(cmd);
    const dev = client().getDevice(serial);
    const s = await dev.shell(composed);
    installAbortAndTimeout(s, opts);
    const buf = await readAll(s);
    const out = buf.toString('utf8');
    const m = out.match(/\n__EDGE_CODE:(\d+)\s*$/);
    const code = m ? Number(m[1]) : null;
    const stdout = m ? out.replace(/\n__EDGE_CODE:\d+\s*$/, '') : out;
    log.debug('[debug] adbShell(adbkit): end', { code });
    return { code, stdout, stderr: '' };
  });
}

export async function adbStream(
  cmd: string,
  opts: AdbOptions,
  onLine: (line: string) => void,
) {
  return measureBlock('adb.adbStream', async () => {
    log.debug('[debug] adbStream(adbkit): start');
    const serial = await resolveSerial(opts);
    const dev = client().getDevice(serial);
    const s = await dev.shell(cmd);
    installAbortAndTimeout(s, opts);
    let residual = '';
    await new Promise<void>((resolve, reject) => {
      s.on('data', (b: Buffer) => {
        const all = residual + b.toString('utf8');
        const parts = all.split(/\r?\n/);
        residual = parts.pop() ?? '';
        for (const p of parts) onLine(p);
      });
      s.on('error', reject);
      s.on('end', () => {
        if (residual) onLine(residual);
        resolve();
      });
    });
    log.debug('[debug] adbStream(adbkit): end');
  });
}

// ─────────────────────────────────────────────────────────────
//  연결 후보 탐색 / 헬스체크(경량)
// ─────────────────────────────────────────────────────────────
export type AdbDevice = { id: string; state: 'device' | 'unauthorized' | 'offline' | string };

export async function listDevices(_opts?: {
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<AdbDevice[]> {
  const list = await client().listDevices();
  // d.type 또는 d.state 어느 쪽이든 수용
  return list.map((d) => ({ id: d.id, state: (d.type ?? (d as any).state) as any }));
}

export async function getState(
  serial: string,
  _opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<string> {
  const list = await client().listDevices();
  const found = list.find((d) => d.id === serial);
  return found ? (found.type ?? (found as any).state ?? 'unknown') : 'unknown';
}

// ─────────────────────────────────────────────────────────────
//  파일 전송 헬퍼 (adbkit v3: device.pull/push)
// ─────────────────────────────────────────────────────────────
export async function adbMkdirP(dir: string, opts: AdbOptions) {
  await adbShell(`mkdir -p "${dir}"`, opts);
}

export async function adbPullFile(remote: string, localFs: string, opts: AdbOptions) {
  const serial = await resolveSerial(opts);
  const dev = client().getDevice(serial);
  const s = await dev.pull(remote);
  await fsp.mkdir(path.dirname(localFs), { recursive: true });
  await new Promise<void>((res, rej) => {
    const ws = fs.createWriteStream(localFs);
    s.on('error', rej);
    ws.on('error', rej);
    ws.on('close', () => res());
    s.pipe(ws);
  });
}

export async function adbPushFile(localFs: string, remote: string, opts: AdbOptions) {
  const serial = await resolveSerial(opts);
  const dev = client().getDevice(serial);
  await adbMkdirP(path.posix.dirname(remote), opts);
  const rs = fs.createReadStream(localFs);
  const xfer = await dev.push(rs, remote);
  await new Promise<void>((res, rej) => {
    xfer.on('end', () => res());
    xfer.on('error', rej);
  });
}

/** 원격 디렉터리 아래 모든 파일 리스트(상대 경로) */
export async function adbListFilesRec(remoteDir: string, opts: AdbOptions): Promise<string[]> {
  const { stdout } = await adbShell(
    `find "${remoteDir}" -type f -print0 2>/dev/null | sed -z 's#^${remoteDir}/##'`,
    opts,
  );
  return stdout.split('\0').map((s) => s.trim()).filter(Boolean);
}