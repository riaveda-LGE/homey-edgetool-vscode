// src/core/controller/GitController.ts
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';
import { exec as execCb } from 'child_process';
import { measure } from '../logging/perf.js';
import { getLogger } from '../logging/extension-logger.js';
import { HostController } from './HostController.js';

const exec = promisify(execCb);
const log = getLogger('GitController');

export type PullOptions = {
  skipCommit?: boolean;
  commitMessage?: string;
  localPath?: string;
};
export type PushOptions = {
  hostPath?: string;
};

const DEFAULT_PULL_MESSAGE: Record<string, string> = {
  pro:    '[Do not push] download homey_pro',
  core:   '[Do not push] download homey_core',
  sdk:    '[Do not push] download homey_sdk',
  bridge: '[Do not push] download homey_bridge',
  host:   '[Do not push] download host_sync',
};

export class GitController {
  constructor(private host: HostController, private workspaceFs: string) {}

  @measure()
  async pull(target: 'pro'|'core'|'sdk'|'bridge'|'host', hostAbsPath?: string, opts?: PullOptions) {
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

    if (!opts?.skipCommit) {
      const msg = opts?.commitMessage || DEFAULT_PULL_MESSAGE[target];
      const { fileCount, durationMs } = await this.commitAsync(msg);
      log.info(`pull[${target}] commit: ${fileCount} files, ${durationMs}ms`);
    } else {
      log.info(`pull[${target}] completed (skipCommit=true)`);
    }
  }

  @measure()
  async push(arg?: string, opts?: PushOptions) {
    log.debug('[debug] push:start', { arg, opts });
    const files = !arg ? await this.getAllCommitFiles() : await this._inferFilesFromArg(arg);
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
    const staged: string[] = [], unstaged: string[] = [], untracked: string[] = [];
    for (const ln of lines) {
      const code = ln.slice(0, 2);
      const file = ln.slice(3);
      if (/^[A-Z][ ]/.test(code)) staged.push(file);
      else if (/^[ ][A-Z]/.test(code)) unstaged.push(file);
      else if (/^\?\?/.test(code)) untracked.push(file);
    }
    log.info('=== git status ===');
    if (staged.length)   log.info(`[STAGED] (${staged.length})\n  - ${staged.join('\n  - ')}`);
    if (unstaged.length) log.info(`[UNSTAGED] (${unstaged.length})\n  - ${unstaged.join('\n  - ')}`);
    if (untracked.length)log.info(`[UNTRACKED] (${untracked.length})\n  - ${untracked.join('\n  - ')}`);
    if (!lines.length)   log.info('clean working tree');
  }

  @measure()
  async amend() {
    const { stdout } = await exec('git log --oneline -1', { cwd: this.workspaceFs });
    if (!stdout.trim()) {
      log.info('amend: 최근 커밋이 없습니다.');
      return;
    }
    const escaped = 'git commit --amend';
    const ps = `Start-Process -FilePath 'cmd' -ArgumentList '/k','${escaped}' -WindowStyle Normal`;
    await exec(`powershell -NoProfile -NonInteractive -Command "${ps}"`);
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
    stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(f => set.add(path.join(this.workspaceFs, f)));
    return Array.from(set);
  }

  @measure()
  async getFilesSince(commitId: string): Promise<string[]> {
    const { stdout } = await exec(`git diff --name-only ${commitId}..HEAD`, { cwd: this.workspaceFs });
    return stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(f => path.join(this.workspaceFs, f));
  }

  @measure()
  async pushFilesByCategory(files: string[], opts?: PushOptions) {
    const buckets = {
      pro: [] as string[], core: [] as string[], sdk: [] as string[], bridge: [] as string[], host: [] as string[],
    };
    for (const f of files) {
      const norm = f.replace(/\\/g, '/');
      if (norm.includes('/homey_pro/')) buckets.pro.push(f);
      else if (norm.includes('/homey_core/')) buckets.core.push(f);
      else if (norm.includes('/homey-apps-sdk-v3/') || norm.includes('/homey_sdk/')) buckets.sdk.push(f);
      else if (norm.includes('/homey-bridge/') || norm.includes('/homey_bridge/')) buckets.bridge.push(f);
      else if (norm.includes('/host_sync/')) buckets.host.push(f);
    }
    // 전송(파일/디렉토리) — 현재는 훅으로 로깅만, 다음 단계에서 실제 전송 구현
    for (const f of buckets.host) {
      const target = opts?.hostPath ? opts.hostPath : this.host.toHostFromLocalHostSync(f);
      await this.host.pushFile(f, target);
    }
    // homey_* 카테고리: 원격 베이스 + 상대경로 계산
    for (const kind of ['pro','core','sdk','bridge'] as const) {
      if (!(buckets as any)[kind].length) continue;
      const base = await this.host.resolveHomeyPath(kind);
      for (const f of (buckets as any)[kind] as string[]) {
        const rel = this._relUnder(f, `homey_${kind}`);
        await this.host.pushFile(f, path.posix.join(base, rel));
      }
    }
    log.info(`push 완료 (host:${buckets.host.length}, pro:${buckets.pro.length}, core:${buckets.core.length}, sdk:${buckets.sdk.length}, bridge:${buckets.bridge.length})`);
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
    const { stdout } = await exec('git diff --name-only HEAD~1..HEAD || git show --name-only --pretty=format:', {
      cwd: this.workspaceFs,
    });
    const files = stdout.split(/\r?\n/).filter(Boolean);
    return { fileCount: files.length, durationMs: Date.now() - start };
  }
}