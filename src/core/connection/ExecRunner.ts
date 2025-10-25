/**
 * === 프로세스 종료 정책 (SIGTERM → SIGKILL 폴백) ===
 *
 * 왜 필요한가?
 * 1. SIGTERM만 보낼 경우:
 *    - 일부 프로세스는 종료 요청을 무시하거나, 긴 작업 때문에 즉시 종료되지 않을 수 있음.
 *    - 그 결과 Node.js 쪽에서는 프로세스가 좀비 상태로 남아 자원을 계속 점유할 위험이 있음.
 *
 * 2. SIGKILL 폴백:
 *    - SIGTERM으로 "정상 종료 요청"을 먼저 보낸 뒤,
 *      일정 시간(예: 1~2초) 동안 프로세스가 종료되지 않으면 SIGKILL을 보내 강제로 종료.
 *    - 리눅스/맥: SIGKILL 사용.
 *    - 윈도우: `taskkill /T /F` 명령을 사용하여 프로세스 트리 전체 강제 종료.
 *
 * 장점:
 * - 정상 종료 시도 → 데이터 flush 및 cleanup 보장.
 * - 그래도 안 죽으면 강제 종료 → 좀비 프로세스 확실히 제거.
 * - 운영체제 차이 대응 가능.
 *
 * 요약:
 *   [Timeout/Abort 발생]
 *         ↓
 *   child.kill('SIGTERM')    ← 정상 종료 요청
 *         ↓ (유예 시간 대기)
 *   살아있으면 → SIGKILL/Taskkill ← 강제 종료
 */

import { execFile, spawn } from 'child_process';

import { getLogger } from '../logging/extension-logger.js';
import { measureBlock } from '../logging/perf.js';

export type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number; // 전체 타임아웃
  signal?: AbortSignal; // 외부 AbortController
  onStdout?: (buf: Buffer) => void;
  onStderr?: (buf: Buffer) => void;
  shell?: 'powershell' | 'sh';
  killGraceMs?: number; // ⬅️ SIGTERM 후 강제 종료까지 기다릴 유예(기본 1500ms)
};

const log = getLogger('ExecRunner');

/**
 * 외부 커맨드를 셸로 실행하고 종료 코드를 반환.
 * - timeout/abort 시: 먼저 SIGTERM(정상 종료 요청) → 유예 후 SIGKILL(강제 종료)
 * - Windows: taskkill /T /F 로 프로세스 트리 강제 종료 폴백
 */
export async function runCommandLine(
  cmd: string,
  opts: ExecOptions = {},
): Promise<{ code: number | null }> {
  return measureBlock('ExecRunner.runCommandLine', async () => {
    log.debug('[debug] runCommandLine: start');
    const isWin = process.platform === 'win32';
    // honor opts.shell if provided, otherwise choose sensible default per-OS
    const sh =
      opts.shell === 'powershell'
        ? 'powershell.exe'
        : opts.shell === 'sh'
          ? '/bin/sh'
          : isWin
            ? 'powershell.exe'
            : '/bin/sh';
    const args = sh.endsWith('powershell.exe')
      ? ['-NoLogo', '-NoProfile', '-Command', cmd]
      : ['-c', cmd];

    const grace = Math.max(0, opts.killGraceMs ?? 1500);

    return new Promise((resolve, reject) => {
      const child = spawn(sh, args, { cwd: opts.cwd, env: opts.env });

      let finished = false;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let termGraceTimer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        log.debug('[debug] runCommandLine cleanup: start');
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
        if (termGraceTimer) {
          clearTimeout(termGraceTimer);
          termGraceTimer = undefined;
        }
        opts.signal?.removeEventListener('abort', onAbort);
        log.debug('[debug] runCommandLine cleanup: end');
      };

      const settle = (code: number | null) => {
        log.debug('[debug] runCommandLine settle: start');
        if (finished) return;
        finished = true;
        cleanup();
        resolve({ code });
        log.debug('[debug] runCommandLine settle: end');
      };

      // --- stdout/stderr 파이프
      child.stdout?.on('data', (b) => opts.onStdout?.(b));
      child.stderr?.on('data', (b) => opts.onStderr?.(b));

      child.on('error', (e) => {
        log.debug('[debug] runCommandLine on error');
        if (finished) return;
        cleanup();
        reject(e);
      });

      child.on('close', (code) => {
        log.debug('[debug] runCommandLine on close');
        settle(code);
      });

      // === 종료 로직 ===

      const killProcessTreeWindows = (pid: number) => {
        log.debug('[debug] killProcessTreeWindows: start');
        // /T: 트리 전체, /F: 강제
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], (err) => {
          if (err) log.warn(`taskkill failed pid=${pid}: ${String(err)}`);
        });
        log.debug('[debug] killProcessTreeWindows: end');
      };

      const sendSigterm = () => {
        log.debug('[debug] sendSigterm: start');
        try {
          // 일부 플랫폼에서 SIGTERM 미지원 시 기본 신호로 대체될 수 있음
          const ok = child.kill('SIGTERM');
          if (!ok) log.warn('SIGTERM dispatch returned false');
        } catch (e) {
          log.warn('SIGTERM dispatch error:', e);
        }
        log.debug('[debug] sendSigterm: end');
      };

      const sendSigkillOrTaskkill = () => {
        log.debug('[debug] sendSigkillOrTaskkill: start');
        try {
          if (isWin) {
            if (child.pid) killProcessTreeWindows(child.pid);
            else log.warn('No PID for taskkill');
          } else {
            const ok = child.kill('SIGKILL');
            if (!ok) log.warn('SIGKILL dispatch returned false');
          }
        } catch (e) {
          log.warn('Force kill error:', e);
        }
        log.debug('[debug] sendSigkillOrTaskkill: end');
      };

      const terminateWithFallback = (reason: 'timeout' | 'aborted') => {
        log.debug('[debug] terminateWithFallback: start');
        if (finished) return;
        log.warn(`killing sub process: ${reason}`);
        // 1) 정상 종료 시도
        sendSigterm();
        // 2) 유예 후 강제 종료
        termGraceTimer = setTimeout(() => {
          if (finished) return;
          sendSigkillOrTaskkill();
        }, grace);
        log.debug('[debug] terminateWithFallback: end');
      };

      // timeout 타이머
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => terminateWithFallback('timeout'), opts.timeoutMs);
      }

      // abort 신호
      const onAbort = () => terminateWithFallback('aborted');
      opts.signal?.addEventListener('abort', onAbort);
    });
  });
}
