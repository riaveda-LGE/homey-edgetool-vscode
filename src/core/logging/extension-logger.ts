// === src/core/logging/extension-logger.ts ===
import * as vscode from 'vscode';

import {
  LOG_CHANNEL_NAME,
  LOG_FLUSH_INTERVAL_MS,
  LOG_IGNORE_KEYWORDS,
  LOG_MAX_BUFFER,
} from '../../shared/const.js';

// test 모드(npm run test)에서는 VS Code 로그 채널 대신 콘솔로 보냄
import { isTestMode } from './test-mode.js';
import { getConsoleLogger } from './console-logger.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Sink = (line: string) => void;

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

class ExtensionLoggerCore {
  private level: LogLevel = 'debug';
  private channel = vscode.window.createOutputChannel(LOG_CHANNEL_NAME);
  private sinks = new Set<Sink>();
  private buffer: string[] = [];

  private pendingForWebview: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  private consolePatched = false;
  private origConsole?: {
    log: typeof console.log;
    info: typeof console.info;
    warn: typeof console.warn;
    error: typeof console.error;
  };

  private webviewReady = false;

  setLevel(level: LogLevel) {
    this.level = level;
  }
  getLevel() {
    return this.level;
  }

  setWebviewReady(ready: boolean) {
    this.webviewReady = ready;
  }
  getWebviewReady() {
    return this.webviewReady;
  }

  addSink(sink: Sink) {
    this.sinks.add(sink);
    if (this.buffer.length) {
      const start = Math.max(0, this.buffer.length - LOG_MAX_BUFFER);
      for (let i = start; i < this.buffer.length; i++) sink(this.buffer[i]);
    }
  }
  removeSink(sink: Sink) {
    this.sinks.delete(sink);
  }

  getLogger(scope: string) {
    const emit = (lvl: LogLevel, args: any[]) => this._emit(lvl, scope, args);
    return {
      debug: (...a: any[]) => emit('debug', a),
      info: (...a: any[]) => emit('info', a),
      warn: (...a: any[]) => emit('warn', a),
      error: (...a: any[]) => emit('error', a),
    };
  }

  /** console.*을 로거로 후킹 (다른 확장 로그는 필터링) */
  patchConsole() {
    if (this.consolePatched) return;
    this.consolePatched = true;
    this.origConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    const c = this.getLogger('console');
    this.channel.appendLine('[debug] extension-logger: patchConsole start');

    const shouldIgnore = (args: any[]) => {
      const joined = args.map(String).join(' ');
      return LOG_IGNORE_KEYWORDS.some((kw) => joined.includes(kw));
    };

    console.log = (...a: any[]) => {
      this.origConsole!.log(...a);
      if (!shouldIgnore(a)) c.info(...a);
    };
    console.info = (...a: any[]) => {
      this.origConsole!.info(...a);
      if (!shouldIgnore(a)) c.info(...a);
    };
    console.warn = (...a: any[]) => {
      this.origConsole!.warn(...a);
      if (!shouldIgnore(a)) c.warn(...a);
    };
    console.error = (...a: any[]) => {
      this.origConsole!.error(...a);
      if (!shouldIgnore(a)) c.error(...a);
    };
    this.channel.appendLine('[debug] extension-logger: patchConsole end');
  }

  unpatchConsole() {
    if (!this.consolePatched || !this.origConsole) return;
    console.log = this.origConsole.log;
    console.info = this.origConsole.info;
    console.warn = this.origConsole.warn;
    console.error = this.origConsole.error;
    this.consolePatched = false;
    this.origConsole = undefined;
  }

  private _emit(level: LogLevel, scope: string, args: any[]) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const now = new Date();
    const ts =
      now.toTimeString().split(' ')[0] + '.' + now.getMilliseconds().toString().padStart(3, '0');

    const body = args
      .map((a) => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object') {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      })
      .join(' ');

    const shortLevel =
      level === 'debug'
        ? 'D'
        : level === 'info'
          ? 'I'
          : level === 'warn'
            ? 'W'
            : level === 'error'
              ? 'E'
              : '?';

    const line = `[${ts}] [${shortLevel}] [${scope}] ${body}`;

    // edge-panel 준비 전: 즉시 console.log로 출력
    if (!this.webviewReady) {
      this.origConsole?.log(line);
    }

    // 1) VSCode Output Channel
    this.channel.appendLine(line);

    // 2) 메모리 버퍼
    this.buffer.push(line);
    if (this.buffer.length > LOG_MAX_BUFFER) {
      this.buffer.splice(0, this.buffer.length - LOG_MAX_BUFFER);
    }

    // 3) 웹뷰 싱크
    if (this.sinks.size) {
      this.pendingForWebview.push(line);
      this.scheduleFlush();
    }
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      const batch = this.pendingForWebview.splice(0, this.pendingForWebview.length);
      if (batch.length) {
        for (const sink of this.sinks) {
          for (const line of batch) sink(line);
        }
      }
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
    }, LOG_FLUSH_INTERVAL_MS);
  }

  /** ✅ 버퍼 읽기 (복원용) */
  getBuffer(): string[] {
    return [...this.buffer];
  }
}

const core = new ExtensionLoggerCore();

export function setLogLevel(level: LogLevel) {
  core.setLevel(level);
}
export function getLogLevel() {
  return core.getLevel();
}
export function setWebviewReady(ready: boolean) {
  core.setWebviewReady(ready);
}
export function getWebviewReady() {
  return core.getWebviewReady();
}
export function getLogger(scope: string) {
  // ✅ 테스트 실행 시엔 뷰(panel) 대신 콘솔로 직행
  if (isTestMode()) {
    return getConsoleLogger(scope) as any;
  }
  return core.getLogger(scope);
}
export function addLogSink(sink: Sink) {
  core.addSink(sink);
}
export function removeLogSink(sink: Sink) {
  core.removeSink(sink);
}
export function patchConsole() {
  core.patchConsole();
}
export function unpatchConsole() {
  core.unpatchConsole();
}
export function getBufferedLogs(): string[] {
  return core.getBuffer();
}
