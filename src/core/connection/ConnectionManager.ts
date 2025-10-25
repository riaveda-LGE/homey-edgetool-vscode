import { ErrorCategory, XError } from '../../shared/errors.js';
import { getLogger } from '../logging/extension-logger.js';
import { measure } from '../logging/perf.js';
import { adbShell, adbStream } from './adbClient.js';
import { sshRun, sshStream } from './sshClient.js';

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

export interface IConnectionManager {
  connect(): Promise<void>;
  isConnected(): boolean;
  run(cmd: string, args?: string[]): Promise<RunResult>;
  stream(cmd: string, onLine: (line: string) => void, abort?: AbortSignal): Promise<void>;
  dispose(): void;
}

export class ConnectionManager implements IConnectionManager {
  private log = getLogger('ConnectionManager');
  private connected = false;
  constructor(private cfg: HostConfig) {}

  @measure()
  async connect() {
    this.log.info(
      `[debug] ConnectionManager.connect: start type=${this.cfg.type} id=${this.cfg.id}`,
    );
    // 가벼운 프리체크 정도만: 실제 연결은 실행 시점에 테스트됨
    this.connected = true;
    this.log.info(`[debug] ConnectionManager.connect: end`);
  }

  @measure()
  isConnected() {
    return this.connected;
  }

  @measure()
  async run(cmd: string, args: string[] = []): Promise<RunResult> {
    this.log.debug(`[debug] ConnectionManager.run: start cmd=${cmd}`);
    try {
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
      this.log.debug(`[debug] ConnectionManager.run: end code=${code}`);
      return { code };
    } catch (e) {
      this.log.error(
        `[debug] ConnectionManager.run: error ${e instanceof Error ? e.message : String(e)}`,
      );
      throw new XError(
        ErrorCategory.Connection,
        `Command failed: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }
  }

  @measure()
  async stream(cmd: string, onLine: (line: string) => void, abort?: AbortSignal) {
    this.log.debug(`[debug] ConnectionManager.stream: start cmd=${cmd}`);
    try {
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
      this.log.debug(`[debug] ConnectionManager.stream: end`);
    } catch (e) {
      this.log.error(
        `[debug] ConnectionManager.stream: error ${e instanceof Error ? e.message : String(e)}`,
      );
      throw new XError(
        ErrorCategory.Connection,
        `Stream failed: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }
  }

  @measure()
  dispose() {
    this.log.info(`[debug] ConnectionManager.dispose: start`);
    this.connected = false;
    this.log.info(`[debug] ConnectionManager.dispose: end`);
  }
}
