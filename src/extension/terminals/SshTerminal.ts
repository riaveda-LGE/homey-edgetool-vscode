// === src/extension/terminals/SshTerminal.ts ===
import { Client } from 'ssh2';
import * as vscode from 'vscode';

import { connectionManager } from '../../core/connection/ConnectionManager.js';
import { getLogger } from '../../core/logging/extension-logger.js';

const log = getLogger('terminal.ssh');

type ActiveSshDetails = {
  host: string;
  user: string;
  port?: number;
  password?: string;
};

function getActiveSsh(): ActiveSshDetails | undefined {
  const snap = connectionManager.getSnapshot?.();
  const active = snap?.active;
  if (!active || active.type !== 'SSH') return undefined;
  const d = active.details as any;
  if (!d?.host || !d?.user) return undefined;
  return { host: d.host, user: d.user, port: d.port, password: d.password };
}

export class SshPtyTerminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  onDidWrite: vscode.Event<string> = this.writeEmitter.event;

  private closeEmitter = new vscode.EventEmitter<void>();
  onDidClose?: vscode.Event<void> = this.closeEmitter.event;

  private conn?: Client;
  // 일부 환경에서 ssh2 타입 정의(@types/ssh2 등) 충돌을 피하기 위해 최소 호환 타입 사용
  private chan?: {
    write(data: string | Buffer): void;
    end(): void;
    stderr?: { on(event: 'data', listener: (data: Buffer) => void): any };
    on(event: 'data', listener: (data: Buffer) => void): any;
    on(event: 'close', listener: () => void): any;
    setWindow?(rows: number, cols: number, height: number, width: number): void;
  };
  private disposed = false;
  private dims?: { cols: number; rows: number };

  constructor(private readonly details?: ActiveSshDetails) {}

  open(initialDimensions?: vscode.TerminalDimensions): void {
    const details = this.details ?? getActiveSsh();
    if (!details) {
      this.writeLine('\r\n[SSH] 활성 SSH 연결 정보를 찾을 수 없습니다.\r\n');
      this.close();
      return;
    }
    if (initialDimensions) {
      this.dims = { cols: initialDimensions.columns, rows: initialDimensions.rows };
    }

    const conn = new Client();
    this.conn = conn;

    conn
      .on('ready', () => {
        // 요청 시크: xterm-color, 로케일/치수
        const term = 'xterm-color';
        const cols = this.dims?.cols ?? 120;
        const rows = this.dims?.rows ?? 30;
        // 일부 타입 정의에서 Client.shell 이 누락되어 있을 수 있어 any 캐스팅으로 호출
        (conn as any).shell({ term, cols, rows }, (err: Error | undefined, stream: any) => {
          if (err) {
            this.writeLine(`\r\n[SSH] shell open 실패: ${String(err?.message || err)}\r\n`);
            this.close();
            return;
          }
          this.chan = stream as typeof this.chan;

          // welcome line
          this.writeLine(
            `[SSH] Connected: ${details.user}@${details.host}${details.port ? ':' + details.port : ''}\r\n`,
          );

          stream.on('close', () => {
            this.close();
          });
          stream.on('data', (data: Buffer) => {
            // 그대로 프록시
            this.writeEmitter.fire(data.toString('utf8'));
          });
          (stream.stderr as any).on('data', (data: Buffer) => {
            this.writeEmitter.fire(data.toString('utf8'));
          });
        });
      })
      .on('error', (e) => {
        this.writeLine(`\r\n[SSH] 연결 실패: ${String((e as any)?.message || e)}\r\n`);
        this.close();
      })
      .on('end', () => {
        this.close();
      })
      .connect({
        host: details.host,
        port: details.port ?? 22,
        username: details.user,
        password: details.password,
        readyTimeout: 15000,
        keepaliveInterval: 10000,
        tryKeyboard: false,
      });
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.chan?.end();
    } catch {}
    try {
      this.conn?.end();
    } catch {}
    this.closeEmitter.fire();
  }

  handleInput(data: string): void {
    // 사용자의 키입력을 그대로 SSH 채널에 전달
    try {
      this.chan?.write(data);
    } catch {}
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.dims = { cols: dimensions.columns, rows: dimensions.rows };
    try {
      if (this.chan && typeof (this.chan as any).setWindow === 'function') {
        // rows, cols, height, width
        (this.chan as any).setWindow(
          this.dims.rows,
          this.dims.cols,
          this.dims.rows,
          this.dims.cols,
        );
      }
    } catch {}
  }

  private writeLine(s: string) {
    this.writeEmitter.fire(s.endsWith('\n') ? s : s + '\n');
  }
}

export function createSshTerminal(): { pty: SshPtyTerminal; title: string } | undefined {
  const d = getActiveSsh();
  if (!d) return undefined;
  return {
    pty: new SshPtyTerminal(d),
    title: `Host Shell (ssh:${d.user}@${d.host}${d.port ? ':' + d.port : ''})`,
  };
}
