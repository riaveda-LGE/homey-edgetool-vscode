// === src/core/connection/sshClient.ts ===
import { Client } from 'ssh2';

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

function connectOnce(opts: SshOptions): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const readyTimeout = Math.max(1, opts.timeoutMs ?? 15000);
    conn
      .on('ready', () => resolve(conn))
      .on('error', (e: unknown) => reject(e as unknown))
      .connect({
        host: opts.host,
        port: opts.port ?? 22,
        username: opts.user,
        password: opts.password, // 비밀번호 인증
        readyTimeout,
        keepaliveInterval: 10000,
        tryKeyboard: false,
      });
  });
}

export async function sshRun(
  cmd: string,
  opts: SshOptions,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return measureBlock('ssh.sshRun', async () => {
    log.debug('[debug] sshRun: start');
    const conn = await connectOnce(opts);
    try {
      const out: { code: number | null; stdout: string; stderr: string } = {
        code: 0,
        stdout: '',
        stderr: '',
      };
      await new Promise<void>((resolve, reject) => {
        conn.exec(cmd, (err: Error | undefined, stream: any) => {
          if (err) return reject(err);
          stream
            .on('close', (code: number | null) => {
              out.code = code ?? 0;
              resolve();
              conn.end();
            })
            .on('data', (b: Buffer) => {
              out.stdout += b.toString('utf8');
              process.stdout.write(b);
            });
          (stream.stderr as any).on('data', (b: Buffer) => {
            out.stderr += b.toString('utf8');
            process.stderr.write(b);
          });
        });
      });
      log.debug('[debug] sshRun: end');
      return out;
    } finally {
      // 안전 종료
      try {
        conn.end();
      } catch {}
    }
  });
}

export async function sshStream(cmd: string, opts: SshOptions, onLine: (line: string) => void) {
  return measureBlock('ssh.sshStream', async () => {
    log.debug('[debug] sshStream: start');
    const conn = await connectOnce(opts);
    let residual = '';
    const abort = () => {
      try {
        conn.end();
      } catch {}
    };
    if (opts.signal) opts.signal.addEventListener('abort', abort, { once: true });
    await new Promise<void>((resolve, reject) => {
      conn.exec(cmd, (err: Error | undefined, stream: any) => {
        if (err) return reject(err);
        stream
          .on('close', () => {
            if (opts.signal) opts.signal.removeEventListener('abort', abort);
            resolve();
            try {
              conn.end();
            } catch {}
          })
          .on('data', (b: Buffer) => {
            const all = residual + b.toString('utf8');
            const parts = all.split(/\r?\n/);
            residual = parts.pop() ?? '';
            for (const p of parts) onLine(p);
          });
        (stream.stderr as any).on('data', (b: Buffer) => process.stderr.write(b));
      });
    });
    log.debug('[debug] sshStream: end');
  });
}

// ─────────────────────────────────────────────────────────────
// 추가: 연결 헬스체크(경량)
// ─────────────────────────────────────────────────────────────
export async function execQuickCheck(t: {
  host: string;
  user?: string;
  port?: number;
  keyPath?: string;
  password?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  try {
    const { code } = await sshRun('true', t);
    return (code ?? 0) === 0;
  } catch {
    return false;
  }
}
