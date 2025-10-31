import * as vscode from 'vscode';

import {
  readUserHomeyConfig,
  readUserHomeyConfigLoose,
  resolveServiceFilePath,
} from '../config/userconfig.js';
import { connectionManager } from '../connection/ConnectionManager.js';
import { getLogger } from '../logging/extension-logger.js';

const log = getLogger('SvcPatcher');

export class ServiceFilePatcher {
  private workdir?: string;
  constructor(
    private unit: string,
    private svcPathGuess = '/lib/systemd/system/homey-pro@.service',
  ) {}

  /**
   * 서비스 파일(단위파일) 실제 경로 해상 순서(강제):
   *  1) .config/custom_user_config.json (SSOT)
   *  2) systemctl FragmentPath
   *  3) 템플릿 기본값(최후 폴백)
   *
   * 주의: 서비스 "이름(unit)"은 재시작에만 사용하고,
   *       파일 경로 판단은 SSOT/FragmentPath로만 결정한다.
   */
  async resolveServicePath(): Promise<string> {
    // 1) 사용자 설정 우선 (edge-go 호환): workspace의 SSOT를 무조건 먼저 본다.
    try {
      // (1) ctx가 있는 경우
      const ctx = (vscode as any)?.extensions?.extensionContext as
        | vscode.ExtensionContext
        | undefined;
      if (ctx) {
        const userCfg = await readUserHomeyConfig(ctx);
        if (userCfg?.homey_service_file_path || userCfg?.homey_service_file_name) {
          const p = resolveServiceFilePath(userCfg);
          log.info(`[SvcPatcher] using service file from user config(ctx): ${p}`);
          return p;
        }
      }
      // (2) ctx 없이도 workspace에서 직접 조회 (검증된 edge-go 플로우)
      const loose = await readUserHomeyConfigLoose();
      if (loose?.homey_service_file_path || loose?.homey_service_file_name) {
        const p = resolveServiceFilePath(loose);
        log.info(`[SvcPatcher] using service file from user config(workspace): ${p}`);
        return p;
      }
    } catch (e) {
      log.warn(
        `[SvcPatcher] user config read failed, will try FragmentPath: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // 2) systemctl FragmentPath 조회
    try {
      const { stdout } = await connectionManager.run(
        `sh -lc 'systemctl show -p FragmentPath "${this.unit}" 2>/dev/null | cut -d= -f2'`,
      );
      const p = String(stdout || '').trim();
      if (p) {
        log.info(`[SvcPatcher] using service file from FragmentPath: ${p}`);
        return p;
      }
    } catch {
      // ignore → fallback
    }

    // 3) 최후 폴백(템플릿 기본값)
    log.warn(
      `[SvcPatcher] FragmentPath empty; falling back to template default: ${this.svcPathGuess}`,
    );
    return this.svcPathGuess;
  }

  /** 작업용 디렉터리 생성 (/tmp/edgetool-<unit>-<ts>) */
  async makeWorkdir(): Promise<string> {
    if (this.workdir) return this.workdir;
    const safeUnit = this.unit.replace(/[^a-zA-Z0-9_.@-]/g, '_');
    const ts = Date.now();
    const dir = `/tmp/edgetool-${safeUnit}-${ts}`;
    await connectionManager.run(`sh -lc 'mkdir -p ${q(dir)} && chmod 700 ${q(dir)}'`);
    this.workdir = dir;
    return dir;
  }

  /** 원본을 작업 카피로 복사(cp -p로 메타 유지)하고 경로 반환 */
  async stageToWorkCopy(origFile: string): Promise<string> {
    const dir = await this.makeWorkdir();
    const work = `${dir}/homey.service.work`;
    const cmd = `sh -lc 'cp -p ${q(origFile)} ${q(work)}'`;
    log.debug(`stageToWorkCopy: cmd=${cmd}`);
    await connectionManager.run(cmd);
    return work;
  }

  /** 작업본으로 원본을 원자적으로 교체 (mv -f) + 교체 전/후 해시 로깅 */
  async replaceOriginalWith(origFile: string, workFile: string): Promise<void> {
    // 루트가 RO일 수 있어 미리 RW 리마운트는 러너에서 수행
    try {
      const beforeHash = await this.computeHash(origFile).catch(() => '');
      const workHash = await this.computeHash(workFile).catch(() => '');
      await connectionManager.run(`sh -lc 'mv -f ${q(workFile)} ${q(origFile)}'`);
      const afterHash = await this.computeHash(origFile).catch(() => '');
      log.debug(
        `[SvcPatcher] replace: hash before=${beforeHash} work=${workHash} after=${afterHash}`,
      );
    } catch (e) {
      // 마지막 수단: mv 재시도 성공 시에는 오류를 전파하지 않는다.
      // eslint-disable-next-line no-useless-catch
      try {
        await connectionManager.run(`sh -lc 'mv -f ${q(workFile)} ${q(origFile)}'`);
        log.warn(
          `[SvcPatcher] replace: fallback mv succeeded after error: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      } catch (e2) {
        throw e2;
      }
    }
  }

  /** 작업 디렉터리 정리 */
  async cleanupWorkdir(): Promise<void> {
    if (!this.workdir) return;
    const d = this.workdir;
    this.workdir = undefined;
    // 필요시 워크디렉터리 전체 정리하고 싶으면 아래 주석 해제
    const cmd = `sh -lc 'rm -rf ${q(d)}'`;
    log.debug(`cleanupWorkdir: cmd=${cmd}`);
    await connectionManager.run(cmd);
  }

  async backup(file: string): Promise<string> {
    const bak = `${file}.bak.${Date.now()}`;
    const cmd = `cp -f "${file}" "${bak}"`;
    await connectionManager.run(`sh -lc ${q(cmd)}`);
    return bak;
  }

  async restore(file: string, backupPath: string): Promise<void> {
    const cmd = `cp -f "${backupPath}" "${file}"`;
    await connectionManager.run(`sh -lc ${q(cmd)}`);
  }

  async insertAfterExecStart(file: string, line: string) {
    log.debug(`insertAfterExecStart: file=${file} line=${line}`);

    // ✅ 사전 중복 검사: 동일 line이 이미 존재하면 아무 것도 하지 않음
    try {
      const containsRe = buildContainsRegex(line); // ^\s*<line>\s*\\?\s*$
      const already = await this.contains(file, containsRe);
      if (already) {
        log.info(`[SvcPatcher] skip insert — already exists: ${line}`);
        return;
      }
    } catch (e) {
      log.warn(
        `[SvcPatcher] pre-check failed (continue insert): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const tmp = `${file}.tmp`;
    const sedScript = `${file}.sed.${Date.now()}`;

    // BusyBox/posix 호환: \s 금지 → [[:space:]] 사용
    // 1) ExecStart= 라인이 백슬래시로 끝나지 않으면 끝에 " \" 추가
    const sed1 = String.raw`/^[[:space:]]*ExecStart=/ { /[[:space:]]\\[[:space:]]*$/! s~$~ \\~ }`;
    // 2) ExecStart= 바로 아래에 한 줄 추가 (sed 'a\'는 다음 줄이 본문)
    const sedA = '/^[[:space:]]*ExecStart=/ a\\';
    // 실제로 추가할 한 줄(서비스 유닛의 줄바꿈 유지용 뒤쪽 백슬래시 1개 포함)
    // sed 'a\' 는 줄 끝의 "\" 를 라인-컨티뉴로 소비한다.
    // 스크립트에는 "\\"(두 개)를 써서, 실제 파일에는 "\" 한 글자가 남도록 한다.
    const appendLine = ` ${esc(line)} \\\\`;

    const sedContent = `${sed1}\n${sedA}\n${appendLine}\n`;

    // 작은 유틸: ADB 단일 커맨드 실행 + 로그
    const run = async (label: string, cmd: string) => {
      log.debug(`[SvcPatcher] ${label}: ${cmd}`);
      // 더블쿼트 안심 래핑: ", $, `, \ 를 이스케이프
      const escaped = cmd.replace(/(["$`\\])/g, '\\$1');
      const res = await connectionManager.run(`sh -lc "${escaped}"`);
      log.debug(`[SvcPatcher] ${label}: exit=${res.code}`);
      if (res.stdout) log.debug(`[SvcPatcher] ${label}[stdout]\n${String(res.stdout)}`);
      if (res.stderr) log.debug(`[SvcPatcher] ${label}[stderr]\n${String(res.stderr)}`);
      if ((res.code ?? 0) !== 0) throw new Error(`${label} failed (code=${res.code})`);
      return res;
    };

    // 1) sed 스크립트 파일 작성
    await run('write-sed', `printf %s ${q(sedContent)} > ${q(sedScript)}`);

    try {
      // 2) 사전 상태(가벼운 로그만)
      await run('stat-before', `ls -l ${q(file)} 2>&1 || true`);
      await run('grep-before', `grep -n '^[[:space:]]*ExecStart=' ${q(file)} 2>&1 || true`);

      // 3) 적용
      await run('apply-sed', `sed -f ${q(sedScript)} ${q(file)} > ${q(tmp)}`);
      // 라인-컨티뉴 강제: 줄 끝의 "\" 뒤에 붙은 공백 제거 (BusyBox sed 호환)
      await run('fix-eol-bslash', `sed -E -i 's/\\\\[[:space:]]*$/\\\\/' ${q(tmp)}`);

      // 4) 결과 최소 검증
      await run(
        'check-tmp',
        `[ -s ${q(tmp)} ] || { echo "[SvcPatcher][ERROR] tmp empty" >&2; exit 31; }`,
      );
      // ExecStart= 라인과 그 다음 2줄까지 미리보기(삽입 라인 가시성)
      await run('grep-after', `grep -nA2 '^[[:space:]]*ExecStart=' ${q(tmp)} 2>&1 || true`);

      // 4-1) 삽입 마커 검증 (정확히 우리가 추가하려는 한 줄이 존재하는지 체크)
      const markerRe = buildMarkerRegex(line); // ^\s*<line>\s*\\?\s*$
      await run('verify-marker', `grep -E ${q(markerRe)} ${q(tmp)} >/dev/null`);

      // 5) 교체
      await run('replace', `mv -f ${q(tmp)} ${q(file)}`);

      // 6) 사후 상태
      await run('stat-after', `ls -l ${q(file)} 2>&1 || true`);
      // 필요시 미리보기 확장
      // if (process.env.EDGETOOL_DEBUG_PREVIEW === '1') {
      //   await run('preview', `{ nl -ba ${q(file)} | sed -n '1,80p'; echo '---'; } 2>&1 || true`);
      // }
    } finally {
      // 7) 청소 (임시 파일 제거)
      await connectionManager
        .run(`sh -lc ${q(`rm -f ${sedScript} ${tmp} 2>/dev/null || true`)}`)
        .catch(() => {});
    }
  }

  // 정규식 삭제: sed -E -e '/pattern/d' ... (패턴 배열을 모두 적용)
  async deleteByRegexPatterns(file: string, patterns: string[]) {
    if (!patterns?.length) return;
    const sedScripts = patterns.map((rx) => `-e ${q(`/${rx}/d`)}`).join(' ');
    const cmd = `sed -E -i ${sedScripts} ${q(file)}`;
    await connectionManager.run(`sh -lc ${q(cmd)}`);
  }

  async daemonReload() {
    await connectionManager.run(`sh -lc 'systemctl daemon-reload'`);
  }
  async restart() {
    await connectionManager.run(
      `sh -lc 'SYSTEMD_PAGER= systemctl restart --no-pager --no-ask-password ${q(this.unit)}'`,
    );
  }

  async contains(file: string, markerRe: string): Promise<boolean> {
    // $1: 정규식, $2: 파일경로 — 중첩 싱글쿼트 문제 회피
    const cmd = `sh -lc 'grep -E "$1" "$2" >/dev/null 2>&1' _ ${q(markerRe)} ${q(file)}`;
    log.debug(`contains: cmd=${cmd}`);
    const { code } = await connectionManager.run(cmd);
    return (code ?? 1) === 0;
  }

  // alias
  async exists(file: string, markerRe: string): Promise<boolean> {
    return this.contains(file, markerRe);
  }

  async computeHash(file: string): Promise<string> {
    const { stdout } = await connectionManager.run(
      `sh -lc 'if command -v sha256sum >/dev/null 2>&1; then sha256sum ${q(file)} | cut -d" " -f1; else md5sum ${q(file)} | cut -d" " -f1; fi'`,
    );
    return String(stdout || '').trim();
  }
}

// NOTE:
// sed 'a\' 본문은 따옴표를 이스케이프할 필요가 없다.
// 따옴표를 \\" 로 남기면 실제 유닛 파일에 백슬래시가 기록되어
// systemd가 "Ignoring unknown escape sequences: "\" " 경고를 낸다.
// 여기서는 sed 스크립트 안전성만 위해 역슬래시(\)만 2배 처리한다.
function esc(s: string) {
  return String(s).replace(/\\/g, '\\\\');
}
function q(s: string) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

// 삽입 라인 존재 검증용 정규식 생성기
// 예: line='--volume="homey-app:/app:rw"' → ^[[:space:]]*--volume\="homey\-app:\/app:rw"[[:space:]]*\\?[[:space:]]*$
function buildMarkerRegex(line: string): string {
  const quoted = regexQuote(line);
  const WS = String.raw`[[:space:]]`;
  // 줄 끝의 "\" 는 선택적으로도 허용하려면 \\? 로 바꿔 사용
  // 여기서는 삽입 직후 라인-컨티뉴가 남는 형태(역슬래시 1개 존재)를 기본으로 검증,
  // 서비스 파일에 이미 동일 내용이 "역슬래시 유/무" 어떤 형태로 있더라도
  // 사전 contains 검사(buildContainsRegex)에서 걸러지므로 안전.
  return String.raw`^${WS}*${quoted}${WS}*\\${WS}*$`;
}

// 정규식 리터럴로 쓰기 위해 문자열 이스케이프
function regexQuote(s: string): string {
  // 대괄호/역슬래시 포함 전체 이스케이프
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '\\"');
}

// ✅ 사전 존재 검사용 정규식: 역슬래시(라인-컨티뉴) 유/무 모두 허용
//   mount/toggle 어디서 오든 동일한 기준으로 "이미 있음"을 판정한다.
function buildContainsRegex(line: string): string {
  const quoted = regexQuote(line);
  const WS = String.raw`[[:space:]]`;
  // ERE: (\\\\)? 는 "백슬래시 0~1개"
  return String.raw`^${WS}*${quoted}${WS}*(\\\\)?${WS}*$`;
}
