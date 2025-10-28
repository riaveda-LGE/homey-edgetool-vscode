// === src/core/connection/sshClient.ts ===
import { getLogger } from '../logging/extension-logger.js';
import { Client } from 'ssh2';
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

export async function sshRun(cmd: string, opts: SshOptions): Promise<number | null> {
  return measureBlock('ssh.sshRun', async () => {
    log.debug('[debug] sshRun: start');
    const conn = await connectOnce(opts);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        conn.exec(cmd, (err: Error | undefined, stream: any) => {
          if (err) return reject(err);
          stream
            .on('close', (code: number | null) => {
              resolve(code ?? 0);
              conn.end();
            })
            .on('data', (b: Buffer) => process.stdout.write(b));
          (stream.stderr as any).on('data', (b: Buffer) => process.stderr.write(b));
        });
      });
      log.debug('[debug] sshRun: end');
      return code;
    } finally {
      // 안전 종료
      try { conn.end(); } catch {}
    }
  });
}

export async function sshStream(cmd: string, opts: SshOptions, onLine: (line: string) => void) {
  return measureBlock('ssh.sshStream', async () => {
    log.debug('[debug] sshStream: start');
    const conn = await connectOnce(opts);
    let residual = '';
    const abort = () => {
      try { conn.end(); } catch {}
    };
    if (opts.signal) opts.signal.addEventListener('abort', abort, { once: true });
    await new Promise<void>((resolve, reject) => {
      conn.exec(cmd, (err: Error | undefined, stream: any) => {
        if (err) return reject(err);
        stream
          .on('close', () => {
            if (opts.signal) opts.signal.removeEventListener('abort', abort);
            resolve();
            try { conn.end(); } catch {}
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
export async function execQuickCheck(
  t: { host: string; user?: string; port?: number; keyPath?: string; password?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<boolean> {
  try {
    const code = await sshRun('true', t);
    return code === 0;
  } catch {
    return false;
  }
}