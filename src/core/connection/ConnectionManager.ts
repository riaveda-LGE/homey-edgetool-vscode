import { adbShell, adbStream } from './adbClient.js';
import { sshRun, sshStream } from './sshClient.js';
import { getLogger } from '../logging/extension-logger.js';

export type HostConfig =
  | {
      id: string;
      type: 'ssh';
      host: string;
      port?: number;
      user: string;
      keyPath?: string;
      password?: string;
      timeoutMs?: number;
    }
  | { id: string; type: 'adb'; serial?: string; timeoutMs?: number };

export type RunResult = { code: number | null };

export class ConnectionManager {
  private log = getLogger('ConnectionManager');
  private connected = false;
  constructor(private cfg: HostConfig) {}

  async connect() {
    // 가벼운 프리체크 정도만: 실제 연결은 실행 시점에 테스트됨
    this.log.info(`connect: type=${this.cfg.type}, id=${this.cfg.id}`);
    this.connected = true;
  }

  isConnected() {
    return this.connected;
  }

  /** 원격 단발 명령 실행 */
  async run(cmd: string, args: string[] = []): Promise<RunResult> {
    const full = [cmd, ...args].join(' ').trim();
    this.log.debug(`run: ${full}`);
    if (this.cfg.type === 'adb') {
      return {
        code: (await adbShell(full, { serial: this.cfg.serial, timeoutMs: this.cfg.timeoutMs }))
          .code,
      };
    }
    const code = await sshRun(full, {
      host: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      keyPath: this.cfg.keyPath,
      password: this.cfg.password,
      timeoutMs: this.cfg.timeoutMs,
    });
    return { code };
  }

  /** 원격 스트림(journalctl/logcat 등) 한 줄씩 콜백 */
  async stream(cmd: string, onLine: (line: string) => void, abort?: AbortSignal) {
    this.log.debug(`stream: ${cmd}`);
    if (this.cfg.type === 'adb') {
      await adbStream(
        cmd,
        { serial: this.cfg.serial, timeoutMs: this.cfg.timeoutMs, signal: abort },
        onLine,
      );
      return;
    }
    await sshStream(
      cmd,
      {
        host: this.cfg.host,
        port: this.cfg.port,
        user: this.cfg.user,
        keyPath: this.cfg.keyPath,
        password: this.cfg.password,
        timeoutMs: this.cfg.timeoutMs,
        signal: abort,
      },
      onLine,
    );
  }

  dispose() {
    this.log.info('dispose');
    this.connected = false;
  }
}
