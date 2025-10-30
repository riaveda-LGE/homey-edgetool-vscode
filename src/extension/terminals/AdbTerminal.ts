// === src/extension/terminals/AdbTerminal.ts ===
import * as child_process from 'child_process';
import * as vscode from 'vscode';

import { getLogger } from '../../core/logging/extension-logger.js';

const log = getLogger('terminal.adb');

export class AdbPtyTerminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  onDidWrite: vscode.Event<string> = this.writeEmitter.event;

  private closeEmitter = new vscode.EventEmitter<void>();
  onDidClose?: vscode.Event<void> = this.closeEmitter.event;

  private proc?: child_process.ChildProcessWithoutNullStreams;
  private disposed = false;

  constructor(private readonly serial?: string) {}

  open(): void {
    const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
    const args = this.serial ? ['-s', this.serial, 'shell'] : ['shell'];

    try {
      this.proc = child_process.spawn(exe, args, { stdio: 'pipe', windowsHide: true });
      // 입력 인코딩 명시
      this.proc.stdin.setDefaultEncoding('utf8');
    } catch (e) {
      this.writeEmitter.fire(`\r\n[ADB] spawn 실패: ${e instanceof Error ? e.message : String(e)}\r\n`);
      this.close();
      return;
    }

    this.writeLine(`[ADB] Connected ${this.serial ? `(serial=${this.serial})` : ''}\r\n`);

    this.proc.stdout.on('data', (b: Buffer) => {
      this.writeEmitter.fire(b.toString('utf8'));
    });
    this.proc.stderr.on('data', (b: Buffer) => {
      this.writeEmitter.fire(b.toString('utf8'));
    });
    this.proc.on('close', (code: number | null) => {
      this.writeLine(`\r\n[ADB] shell 종료 (code=${code ?? 0})\r\n`);
      this.close();
    });
    this.proc.on('error', (e) => {
      this.writeEmitter.fire(`\r\n[ADB] error: ${e instanceof Error ? e.message : String(e)}\r\n`);
      this.close();
    });
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.proc?.stdin.end();
    } catch {}
    try {
      this.proc?.kill();
    } catch {}
    this.closeEmitter.fire();
  }

  handleInput(data: string): void {
    try {
      // VS Code는 Enter를 보통 '\r'로 보냄 → 셸은 '\n'을 요구
      // '\r\n' → '\n', 단일 '\r' → '\n' 로 정규화
      const normalized = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      // 기본 제어키 전달 (필요 시 확장 가능)
      // - Ctrl+C: \x03,  Backspace: \x7f or \b  등은 그대로 패스
      this.proc?.stdin.write(normalized, 'utf8');
    } catch {}
  }

  setDimensions(_: vscode.TerminalDimensions): void {
    // adb는 별도 윈도우 사이즈 신호를 제공하지 않음 (무시)
  }

  private writeLine(s: string) {
    this.writeEmitter.fire(s.endsWith('\n') ? s : s + '\n');
  }
}

export function createAdbTerminal(serial?: string): { pty: AdbPtyTerminal; title: string } {
  const title = `Host Shell (adb:${serial || 'default'})`;
  return { pty: new AdbPtyTerminal(serial), title };
}