// src/core/controller/GitController.ts
import { exec as execCb } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import { getLogger } from '../logging/extension-logger.js';
import { measure } from '../logging/perf.js';
import { HostController } from './HostController.js';
import type { GitLite, GitLiteItem } from '../../shared/ipc/messages.js';

const exec = promisify(execCb);
const log = getLogger('GitController');

export type PullOptions = {
  localPath?: string;
};
export type PushOptions = {
  hostPath?: string;
  /** UI 호출 시 ESC로 입력창이 취소되면 arg가 undefined가 되므로,
   *  이 경우를 '취소'로 간주하도록 의도를 명시할 수 있는 옵션(향후 호환용).
   *  현재 구현은 ui 여부와 무관하게 undefined를 취소로 처리한다. */
  ui?: boolean;
};

const DEFAULT_PULL_MESSAGE: Record<string, string> = {
  pro: '[Do not push] download homey_pro',
  core: '[Do not push] download homey_core',
  sdk: '[Do not push] download homey_sdk',
  bridge: '[Do not push] download homey_bridge',
  host: '[Do not push] download host_sync',
};

export class GitController {
  constructor(
    private host: HostController,
    private workspaceFs: string,
  ) {}

  @measure()
  async pull(
    target: 'pro' | 'core' | 'sdk' | 'bridge' | 'host',
    hostAbsPath?: string,
    opts?: PullOptions,
  ) {
    const ws = this.workspaceFs;
    let localBase = '';
    let remoteBase = '';

    log.debug('[debug] pull:start', { target, hostAbsPath, opts });

    if (target === 'host') {
      if (!hostAbsPath) throw new Error('host pull requires absolute host path');
      remoteBase = hostAbsPath;
      localBase = opts?.localPath || this.host.toLocalFromHost(hostAbsPath);

      const kind = await this.host.statType(remoteBase);
      log.debug('[debug] pull:statType', { target, remoteBase, kind });

      if (kind === 'FILE') await this.host.pullFile(remoteBase, localBase);
      else if (kind === 'DIR') await this.host.pullDir(remoteBase, localBase);
      else {
        log.error('[error] pull:path-not-found', { target, remoteBase });
        throw new Error(`path not found on host: ${remoteBase}`);
      }
    } else {
      remoteBase = await this.host.resolveHomeyPath(target);
      localBase = path.join(ws, `homey_${target}`);

      const kind = await this.host.statType(remoteBase);
      log.debug('[debug] pull:statType', { target, remoteBase, kind });

      if (kind === 'DIR') await this.host.pullDir(remoteBase, localBase);
      else {
        log.error('[error] pull:unexpected-type', { target, remoteBase, kind });
        throw new Error(`unexpected type for ${target}: ${kind}`);
      }
    }

    const msg = DEFAULT_PULL_MESSAGE[target];
    const { fileCount, durationMs } = await this.commitAsync(msg);
    log.info(`pull[${target}] commit: ${fileCount} files, ${durationMs}ms`);
  }

  @measure()
  async push(arg?: string, opts?: PushOptions) {
    log.debug('[debug] push:start', { arg: typeof arg === 'undefined' ? '(undefined)' : arg, opts });
    // ESC/취소 안전망:
    // - 입력창에서 ESC를 누르면 showInputBox가 undefined를 반환한다.
    // - 기존 코드는 !arg 분기로 전체 push가 되어 사고가 발생했다.
    // - 명시적 전체 push는 빈 문자열('')로 처리하고, undefined는 '취소'로 간주한다.
    if (typeof arg === 'undefined') {
      log.info('push: cancelled (arg is undefined)');
      return;
    }
    const files = arg === '' ? await this.getAllCommitFiles() : await this._inferFilesFromArg(arg);
    log.debug('[debug] push:files', { count: files.length });
    if (files.length === 0) {
      log.info('push: 변경 파일이 없습니다.');
      return;
    }
    await this.pushFilesByCategory(files, opts);
  }

  // ────────────────────────────────────────────────────────────
  // status / amend
  // ────────────────────────────────────────────────────────────
  @measure()
  async printStatusSummary() {
    const { stdout } = await exec('git status --porcelain', { cwd: this.workspaceFs });
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    const staged: string[] = [],
      unstaged: string[] = [],
      untracked: string[] = [];
    for (const ln of lines) {
      const code = ln.slice(0, 2);
      const file = ln.slice(3);
      if (/^[A-Z][ ]/.test(code)) staged.push(file);
      else if (/^[ ][A-Z]/.test(code)) unstaged.push(file);
      else if (/^\?\?/.test(code)) untracked.push(file);
    }
    log.info('=== git status ===');
    if (staged.length) log.info(`[STAGED] (${staged.length})\n  - ${staged.join('\n  - ')}`);
    if (unstaged.length)
      log.info(`[UNSTAGED] (${unstaged.length})\n  - ${unstaged.join('\n  - ')}`);
    if (untracked.length)
      log.info(`[UNTRACKED] (${untracked.length})\n  - ${untracked.join('\n  - ')}`);
    if (!lines.length) log.info('clean working tree');
  }
  // ── Internals ───────────────────────────────────────────────
  private async _inferFilesFromArg(arg: string): Promise<string[]> {
    // 커밋ID처럼 보이면: <arg>..HEAD 범위
    if (/^[0-9a-f]{5,40}$/i.test(arg)) {
      return this.getFilesSince(arg);
    }
    // 파일 경로로 취급
    const abs = path.isAbsolute(arg) ? arg : path.join(this.workspaceFs, arg);
    if (fs.existsSync(abs)) return [abs];
    log.info(`인식 실패: ${arg} — 커밋ID 또는 파일경로가 아닙니다.`);
    return [];
  }

  @measure()
  async getAllCommitFiles(): Promise<string[]> {
    // "[Do not push] download ..." 커밋은 제외
    const { stdout } = await exec(
      `git log --grep="^\\[Do not push\\] download" --invert-grep --name-only --pretty=format:`,
      { cwd: this.workspaceFs },
    );
    const set = new Set<string>();
    stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((f) => set.add(path.join(this.workspaceFs, f)));
    return Array.from(set);
  }

  @measure()
  async getFilesSince(commitId: string): Promise<string[]> {
    const { stdout } = await exec(`git diff --name-only ${commitId}..HEAD`, {
      cwd: this.workspaceFs,
    });
    return stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((f) => path.join(this.workspaceFs, f));
  }

  @measure()
  async pushFilesByCategory(files: string[], opts?: PushOptions) {
    const buckets = {
      pro: [] as string[],
      core: [] as string[],
      sdk: [] as string[],
      bridge: [] as string[],
      host: [] as string[],
    };
    for (const f of files) {
      const norm = f.replace(/\\/g, '/');
      if (norm.includes('/homey_pro/')) buckets.pro.push(f);
      else if (norm.includes('/homey_core/')) buckets.core.push(f);
      else if (norm.includes('/homey-apps-sdk-v3/') || norm.includes('/homey_sdk/'))
        buckets.sdk.push(f);
      else if (norm.includes('/homey-bridge/') || norm.includes('/homey_bridge/'))
        buckets.bridge.push(f);
      else if (norm.includes('/host_sync/')) buckets.host.push(f);
    }
    // 전송(파일/디렉토리) — 현재는 훅으로 로깅만, 다음 단계에서 실제 전송 구현
    for (const f of buckets.host) {
      const target = opts?.hostPath ? opts.hostPath : this.host.toHostFromLocalHostSync(f);
      await this.host.pushFile(f, target);
    }
    // homey_* 카테고리: 원격 베이스 + 상대경로 계산
    for (const kind of ['pro', 'core', 'sdk', 'bridge'] as const) {
      if (!(buckets as any)[kind].length) continue;
      const base = await this.host.resolveHomeyPath(kind);
      for (const f of (buckets as any)[kind] as string[]) {
        const rel = this._relUnder(f, `homey_${kind}`);
        await this.host.pushFile(f, path.posix.join(base, rel));
      }
    }
    log.info(
      `push 완료 (host:${buckets.host.length}, pro:${buckets.pro.length}, core:${buckets.core.length}, sdk:${buckets.sdk.length}, bridge:${buckets.bridge.length})`,
    );
  }

  private _relUnder(abs: string, marker: string): string {
    const norm = abs.replace(/\\/g, '/');
    const p = norm.split(`/${marker}/`)[1];
    return p || path.basename(abs);
  }

  @measure()
  async commitAsync(message: string): Promise<{ fileCount: number; durationMs: number }> {
    const start = Date.now();
    await exec('git add -A', { cwd: this.workspaceFs });
    try {
      await exec(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: this.workspaceFs });
    } catch {
      // 커밋할 변경 없음
    }
    const { stdout } = await exec(
      'git diff --name-only HEAD~1..HEAD || git show --name-only --pretty=format:',
      {
        cwd: this.workspaceFs,
      },
    );
    const files = stdout.split(/\r?\n/).filter(Boolean);
    return { fileCount: files.length, durationMs: Date.now() - start };
  }
}

// ────────────────────────────────────────────────────────────
// Git status (lightweight) helpers
// ────────────────────────────────────────────────────────────
export async function getStatusLiteFromDir(workspaceFs: string): Promise<GitLite> {
  // 기본값 (레포가 아니거나 오류 시)
  const EMPTY: GitLite = {
    staged: [],
    modified: [],
    untracked: [],
    conflicts: 0,
    clean: true,
    repo: false,
    branch: null,
  };
  try {
    const { stdout: isRepoOut } = await exec('git rev-parse --is-inside-work-tree', {
      cwd: workspaceFs,
    });
    if (!/^true/i.test(String(isRepoOut).trim())) return EMPTY;
  } catch {
    return EMPTY;
  }

  const result: GitLite = {
    staged: [],
    modified: [],
    untracked: [],
    conflicts: 0,
    clean: true,
    repo: true,
    branch: null,
  };

  try {
    const { stdout: b } = await exec('git rev-parse --abbrev-ref HEAD', { cwd: workspaceFs });
    result.branch = String(b || '').trim() || null;
  } catch {}

  try {
    // -z 포맷은 NUL(\0)로 구분됨. JS에서는 반드시 '\0' 로 split 해야 함.
    const { stdout } = await exec('git status --porcelain=v1 -z -uall', { cwd: workspaceFs });
    const parts = stdout.split('\0').filter((s) => s.length > 0);
    for (let i = 0; i < parts.length; i++) {
      const rec = parts[i];
      if (rec.length < 3) continue;
      const X = rec[0];
      const Y = rec[1];
      const rest = rec.slice(3); // "XY <path>"
      let displayPath = rest;

      const isRenameOrCopy = X === 'R' || X === 'C' || Y === 'R' || Y === 'C';
      if (isRenameOrCopy) {
        // 다음 토큰이 old path
        const oldPath = parts[i + 1] ?? '';
        if (oldPath) {
          displayPath = `${oldPath} → ${rest}`;
          i++; // 소비
        }
      }

      // ignored (!!) 무시
      if (X === '!' && Y === '!') continue;

      // 충돌 케이스(U*, *U, AA, DD 등) 대략 계수
      if (
        X === 'U' ||
        Y === 'U' ||
        (X === 'A' && Y === 'A') ||
        (X === 'D' && Y === 'D') ||
        (X === 'A' && Y === 'D') ||
        (X === 'D' && Y === 'A')
      ) {
        result.conflicts = (result.conflicts || 0) + 1;
        continue; // 목록엔 별도 표시하지 않음(단순화)
      }

      const push = (arr: GitLiteItem[], code: GitLiteItem['code']) =>
        arr.push({ path: displayPath, code });

      if (X !== ' ' && X !== '?') {
        // 인덱스(스테이지드)
        const code: GitLiteItem['code'] = (X as any) in { A: 1, M: 1, D: 1, R: 1, C: 1 } ? (X as any) : 'M';
        push(result.staged, code);
      } else if (X === '?' && Y === '?') {
        push(result.untracked, '??');
      } else if (Y !== ' ' && Y !== '?') {
        // 작업 트리(언스테이지드)
        const code: GitLiteItem['code'] = (Y as any) in { A: 1, M: 1, D: 1, R: 1, C: 1 } ? (Y as any) : 'M';
        push(result.modified, code);
      }
    }

    result.clean =
      (result.staged?.length || 0) === 0 &&
      (result.modified?.length || 0) === 0 &&
      (result.untracked?.length || 0) === 0 &&
      (result.conflicts || 0) === 0;

    return result;
  } catch (e) {
    log.warn(`getStatusLiteFromDir failed: ${e}`);
    return EMPTY;
  }
}
