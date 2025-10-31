import { ErrorCategory, XError } from '../../shared/errors.js';
import type { ConnectionInfo } from '../config/connection-config.js';
import { getLogger } from '../logging/extension-logger.js';
import { measure } from '../logging/perf.js';
import { adbShell, adbStream, getState as adbGetState } from './adbClient.js';
import { execQuickCheck as sshQuickCheck, sshRun, sshStream } from './sshClient.js';
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

export type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export interface IConnectionManager {
  connect(): Promise<void>; // 유지: (호환) 경량 프리체크
  isConnected(): boolean;
  getSnapshot(): { active?: ConnectionInfo; healthy?: boolean; lastCheckedAt?: number };
  setActive(info: ConnectionInfo): void;
  setRecentLoader(loader: () => Promise<ConnectionInfo | undefined>): void;
  checkHealth(info?: ConnectionInfo, abort?: AbortSignal): Promise<boolean>;
  run(cmd: string, args?: string[]): Promise<RunResult>;
  stream(cmd: string, onLine: (line: string) => void, abort?: AbortSignal): Promise<void>;
  dispose(): void;
}

export class ConnectionManager implements IConnectionManager {
  private log = getLogger('ConnectionManager');
  private connected = false;
  private active?: ConnectionInfo;
  private healthy?: boolean;
  private lastCheckedAt?: number;
  private recentLoader?: () => Promise<ConnectionInfo | undefined>;

  // 싱글톤 사용을 위해 기본 생성자
  constructor() {}

  @measure()
  async connect() {
    // 1) active 없으면 recent 로더로 자동 활성화 시도
    if (!this.active && this.recentLoader) {
      try {
        const recent = await this.recentLoader();
        if (recent) this.setActive(recent);
      } catch {
        /* noop: 로더 실패는 치명적 아님 */
      }
    }
    // 2) active 있으면 헬스체크
    if (this.active) {
      try {
        this.healthy = await this.checkHealth();
      } catch {
        this.healthy = false;
      }
      this.connected = true;
    } else {
      this.connected = false; // 여전히 없으면 연결 불가 상태
    }
    this.log.info(`[debug] ConnectionManager.connect: end`);
  }

  @measure()
  isConnected() {
    return !!this.active;
  }

  @measure()
  getSnapshot() {
    return { active: this.active, healthy: this.healthy, lastCheckedAt: this.lastCheckedAt };
  }

  @measure()
  setActive(info: ConnectionInfo) {
    this.active = info;
    this.connected = true;
    this.healthy = undefined;
    this.lastCheckedAt = undefined;
    this.log.info(`[info] active connection set: ${info.id}`);
  }

  @measure()
  setRecentLoader(loader: () => Promise<ConnectionInfo | undefined>) {
    this.recentLoader = loader;
    this.log.debug('[debug] recentLoader registered');
  }

  private toHostConfig(info: ConnectionInfo): HostConfig {
    if (info.type === 'ADB') {
      const serial = (info.details as any)?.deviceID;
      return { id: info.id, type: 'adb', serial, timeoutMs: 15000 };
    } else {
      const d = info.details as any;
      return {
        id: info.id,
        type: 'ssh',
        host: d.host,
        port: d.port,
        user: d.user,
        password: d.password,
        timeoutMs: 15000,
      };
    }
  }

  @measure()
  async checkHealth(info?: ConnectionInfo, abort?: AbortSignal): Promise<boolean> {
    const target = info ?? this.active;
    if (!target) return false;
    let ok = false;
    if (target.type === 'ADB') {
      const serial = (target.details as any)?.deviceID;
      ok = serial ? (await adbGetState(serial, { signal: abort })) === 'device' : false;
    } else {
      const d = target.details as any;
      ok = await sshQuickCheck({
        host: d.host,
        user: d.user,
        port: d.port,
        password: d.password,
        timeoutMs: 5000,
        signal: abort,
      });
    }
    this.healthy = ok;
    this.lastCheckedAt = Date.now();
    return ok;
  }

  @measure()
  async run(cmd: string, args: string[] = []): Promise<RunResult> {
    const via = this.active?.type ?? 'NONE';
    try {
      const full = [cmd, ...args].join(' ').trim();
      if (!this.active) {
        throw new XError(
          ErrorCategory.Connection,
          'No active connection. Please connect a device.',
        );
      }
      const cfg = this.toHostConfig(this.active);
      if (cfg.type === 'adb') {
        this.log.debug('[debug] run(ADB) exec', { serial: cfg.serial, full });
        const res = await adbShell(full, { serial: cfg.serial, timeoutMs: cfg.timeoutMs });
        return { code: res.code, stdout: res.stdout, stderr: res.stderr };
      }
      const { code, stdout, stderr } = await sshRun(full, {
        host: (cfg as any).host,
        port: (cfg as any).port,
        user: (cfg as any).user,
        password: (cfg as any).password,
        timeoutMs: (cfg as any).timeoutMs,
      });
      return { code, stdout, stderr };
    } catch (e) {
      this.log.error(`[debug] ConnectionManager.run: error`, {
        message: e instanceof Error ? e.message : String(e),
      });
      throw new XError(
        ErrorCategory.Connection,
        `Command failed: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }
  }

  @measure()
  async stream(cmd: string, onLine: (line: string) => void, abort?: AbortSignal) {
    const via = this.active?.type ?? 'NONE';
    this.log.debug(`[debug] ConnectionManager.stream: start`);
    try {
      if (!this.active)
        throw new XError(
          ErrorCategory.Connection,
          'No active connection. Please connect a device.',
        );
      const cfg = this.toHostConfig(this.active);
      if (cfg.type === 'adb') {
        this.log.debug('[debug] stream(ADB) exec');
        await adbStream(
          cmd,
          { serial: cfg.serial, timeoutMs: cfg.timeoutMs, signal: abort },
          onLine,
        );
        return;
      }
      this.log.debug('[debug] stream(SSH) exec', {
        host: (cfg as any).host,
        user: (cfg as any).user,
        port: (cfg as any).port,
        cmd,
      });
      await sshStream(
        cmd,
        {
          host: (cfg as any).host,
          port: (cfg as any).port,
          user: (cfg as any).user,
          password: (cfg as any).password,
          timeoutMs: (cfg as any).timeoutMs,
          signal: abort,
        },
        onLine,
      );
    } catch (e) {
      this.log.error(`[debug] ConnectionManager.stream: error`, {
        message: e instanceof Error ? e.message : String(e),
      });
      throw new XError(
        ErrorCategory.Connection,
        `Stream failed: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }
  }

  @measure()
  dispose() {
    this.connected = false;
    this.active = undefined;
    this.healthy = undefined;
    this.lastCheckedAt = undefined;
    this.log.info(`[debug] ConnectionManager.disposed`);
  }
}
// 🔁 싱글톤 인스턴스: 확장 전역에서 공유
export const connectionManager = new ConnectionManager();
