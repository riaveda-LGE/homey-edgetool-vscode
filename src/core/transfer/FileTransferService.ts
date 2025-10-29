import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_TRANSFER_TIMEOUT_MS } from '../../shared/const.js';
import { ErrorCategory, XError } from '../../shared/errors.js';
import type { IConnectionManager } from '../connection/ConnectionManager.js';
import { runCommandLine } from '../connection/ExecRunner.js';
import { getLogger } from '../logging/extension-logger.js';
import { measure } from '../logging/perf.js';

export type TransferOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export interface IFileTransferService {
  uploadViaTarBase64(
    localDir: string,
    remoteDir: string,
    opts?: TransferOptions & { paths?: string[] }, // 상대경로 목록(선택)
  ): Promise<void>;
  downloadViaTarBase64(
    remoteDir: string,
    localDir: string,
    opts?: TransferOptions & { paths?: string[] }, // 상대경로 목록(선택)
  ): Promise<void>;
}

export class FileTransferService implements IFileTransferService {
  private log = getLogger('FileTransfer');
  constructor(private cm: IConnectionManager) {}

  // ───────────────────────────────────────────────────────────
  // Helpers: tar 엔트리를 항상 상대 경로로 강제(+ 경계 케이스 방어)
  // ───────────────────────────────────────────────────────────
  private toPosix(p: string) {
    return p.replace(/\\/g, '/');
  }
  private sq(s: string) {
    // POSIX single-quote safe: 'a'\''b'
    return String(s).replace(/'/g, `'\\''`);
  }
  private wrap(cmd: string) {
    // ConnectionManager.run/stream 과 동일한 규칙 적용(ADB: login shell 금지)
    const flat = cmd.replace(/\n/g, ' ').trim();
    const t = this.cm.getSnapshot()?.active?.type;
    if (t === 'ADB') return `sh -c '${this.sq(flat)}'`;
    return `sh -lc '${this.sq(flat)}'`;
  }
  private async remoteRun(cmd: string) {
    await this.cm.run(this.wrap(cmd));
  }
  private async remoteStream(cmd: string, onLine: (line: string) => void) {
    await this.cm.stream(this.wrap(cmd), onLine);
  }
  private async ensureRemoteDir(absDir: string) {
    await this.remoteRun(`mkdir -p '${this.sq(absDir)}'`);
  }
  private chunkString(s: string, chunkLen = 48 * 1024) {
    const out: string[] = [];
    for (let i = 0; i < s.length; i += chunkLen) out.push(s.slice(i, i + chunkLen));
    return out;
  }
  private printfAppendCmd(dst: string, payload: string) {
    // 작은 따옴표 안전하게 감싸서 printf %s '...' >> dst
    return `printf %s '${this.sq(payload)}' >> '${this.sq(dst)}'`;
  }
  /**
   * 로컬 기준(-C localDir)으로 tar에 넘길 안전한 상대 엔트리 목록 생성.
   * - 절대경로/워크스페이스 밖 경로/.. 포함 시 오류
   * - 비어있으면 ['.'] 반환
   */
  private buildLocalTarList(localDir: string, paths?: string[]): string[] {
    if (!paths || paths.length === 0) return ['.'];

    const out = new Set<string>();
    for (const raw of paths) {
      const t = String(raw ?? '').trim();
      if (!t) continue;

      // 절대/상대 모두 localDir 기준으로 정규화 → 상대 계산
      const abs = path.isAbsolute(t) ? t : path.resolve(localDir, t);
      let rel = this.toPosix(path.relative(localDir, abs));

      // 경계: localDir 밖으로 나가면 차단
      if (!rel || rel === '' || rel === '.') {
        out.add('.');
        continue;
      }
      if (rel.startsWith('..') || rel.split('/').some((seg) => seg === '..')) {
        throw new XError(
          ErrorCategory.Path,
          `Path escapes base dir or contains '..': ${t} (base=${localDir})`,
        );
      }

      // './' 제거, 중복 제거
      rel = rel.replace(/^\.\/+/, '');
      if (rel.length > 0) out.add(rel);
    }
    if (out.size === 0) return ['.'];
    // '.'가 포함되면 전체 포함이므로 개별 엔트리는 무시
    if (out.has('.')) return ['.'];
    return Array.from(out);
  }

  /**
   * 원격 기준(-C remoteDir)으로 tar에 넘길 안전한 상대 엔트리 목록 생성.
   * - 절대경로 금지, '..' 금지
   * - 비어있으면 ['.'] 반환
   */
  private buildRemoteTarList(paths?: string[]): string[] {
    if (!paths || paths.length === 0) return ['.'];

    const out = new Set<string>();
    for (const raw of paths) {
      let t = String(raw ?? '').trim();
      if (!t) continue;

      t = this.toPosix(t)
        .replace(/^\/+/, '') // 절대 → 상대
        .replace(/^\.\//, ''); // 선행 './' 제거

      // normalize (단, '..'는 허용하지 않음)
      const parts: string[] = [];
      for (const seg of t.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') {
          throw new XError(ErrorCategory.Path, `Parent traversal '..' not allowed: ${raw}`);
        }
        parts.push(seg);
      }
      if (parts.length === 0) {
        out.add('.');
      } else {
        out.add(parts.join('/'));
      }
    }
    if (out.size === 0) return ['.'];
    if (out.has('.')) return ['.'];
    return Array.from(out);
  }

  // 인자 인용 유틸: 원격(POSIX 셸) / 로컬(cmd/쉘) 분리
  private quoteListPosix(list: string[]) {
    // 원격은 sh -c/-lc 안에서 단일따옴표 안전 인용
    return list.map((p) => `'${this.sq(p)}'`).join(' ');
  }
  private quoteListLocal(list: string[]) {
    // 로컬 runCommandLine용: 이스케이프 후 큰따옴표로 감쌈
    return list.map((p) => `"${String(p).replace(/"/g, '\\"')}"`).join(' ');
  }

  // ───────────────────────────────────────────────────────────

  @measure()
  async uploadViaTarBase64(
    localDir: string,
    remoteDir: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal; paths?: string[] },
  ) {
    this.log.debug('[debug] FileTransferService uploadViaTarBase64: start');
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
    try {
      // 1) tar 생성 (로컬)
      const safeList = this.buildLocalTarList(localDir, opts?.paths);
      const list = this.quoteListLocal(safeList);
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'edge-up-'));
      const tarPath = path.join(tmpDir, 'payload.tar');
      try {
        await runCommandLine(`tar -C "${localDir}" -cf "${tarPath}" ${list}`, { timeoutMs, signal: opts?.signal });
        const buf = await fsp.readFile(tarPath);
        const b64 = buf.toString('base64');
        const chunks = this.chunkString(b64, 48 * 1024);

        // 2) 원격 준비
        await this.ensureRemoteDir(remoteDir);
        const remoteTmp = `/tmp/edge-upload-${Date.now()}.b64`;
        // truncate
        await this.remoteRun(`: > '${this.sq(remoteTmp)}'`);
        // append in chunks
        for (const ch of chunks) {
          await this.remoteRun(this.printfAppendCmd(remoteTmp, ch));
        }
        // 3) decode & extract
        await this.remoteRun(`base64 -d '${this.sq(remoteTmp)}' | tar -C '${this.sq(remoteDir)}' -xpf - && rm -f '${this.sq(remoteTmp)}'`);
        this.log.info(`upload: ${localDir} -> ${remoteDir} (${safeList.join(', ') || '.'})`);
      } finally {
        try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
      }
      this.log.debug('[debug] FileTransferService uploadViaTarBase64: end');
    } catch (e) {
      throw new XError(
        ErrorCategory.Connection,
        `Upload failed: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }
  }

  @measure()
  async downloadViaTarBase64(
    remoteDir: string,
    localDir: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal; paths?: string[] },
  ) {
    this.log.debug('[debug] FileTransferService downloadViaTarBase64: start');
    try {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;

      // ✅ 강제 상대 엔트리(+ 경계 방어)
      const safeList = this.buildRemoteTarList(opts?.paths);
      const list = this.quoteListPosix(safeList);

      // 1) 원격에서 base64 생성 (ssh2/adb stream 사용)
      const lines: string[] = [];
      await this.remoteStream(`tar -C '${this.sq(remoteDir)}' -cf - ${list} | base64`, (ln) => {
        const t = String(ln ?? '').trim();
        if (t) lines.push(t);
      });
      const b64 = lines.join('');
      if (!b64) {
        this.log.info(`[download] empty archive from ${remoteDir} (${safeList.join(', ') || '.'})`);
        return;
      }

      // 2) 로컬에 임시 tar 저장 후 풀기
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'edge-down-'));
      const tarPath = path.join(tmpDir, 'payload.tar');
      try {
        await fsp.writeFile(tarPath, Buffer.from(b64, 'base64'));
        await fsp.mkdir(localDir, { recursive: true });
        await runCommandLine(`tar -C "${localDir}" -xpf "${tarPath}"`, { timeoutMs, signal: opts?.signal });
        this.log.info(`[download] ${remoteDir} -> ${localDir} (${safeList.join(', ') || '.'})`);
      } finally {
        try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
      }
      this.log.debug('[debug] FileTransferService downloadViaTarBase64: end');
    } catch (e) {
      throw new XError(
        ErrorCategory.Connection,
        `Download failed: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }
  }
}
