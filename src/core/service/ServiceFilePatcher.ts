import { connectionManager } from '../connection/ConnectionManager.js';
import { getLogger } from '../logging/extension-logger.js';

const log = getLogger('SvcPatcher');

export class ServiceFilePatcher {
  constructor(private unit: string, private svcPathGuess = '/lib/systemd/system/homey-pro@.service') {}

  async resolveServicePath(): Promise<string> {
    const { stdout } = await connectionManager.run(
      `sh -lc 'systemctl show -p FragmentPath "${this.unit}" 2>/dev/null | cut -d= -f2'`,
    );
    const p = String(stdout || '').trim();
    return p || this.svcPathGuess;
  }

  async backup(file: string): Promise<string> {
    const bak = `${file}.bak.${Date.now()}`;
    await connectionManager.run(`sh -lc 'cp -f "${file}" "${bak}"'`);
    return bak;
  }

  async restore(file: string, backupPath: string): Promise<void> {
    await connectionManager.run(`sh -lc 'cp -f "${backupPath}" "${file}"'`);
  }

  async insertAfterExecStart(file: string, line: string) {
    // ExecStart= 라인 바로 다음에 원하는 인자를 1줄 추가 (끝에 \\ 유지)
    const cmd = `awk '{ print; if ($0 ~ /^ExecStart=/ && !ins){print "  ${esc(line)} \\\"; ins=1} }' "${file}" > "${file}.tmp" && mv "${file}.tmp" "${file}"`;
    await connectionManager.run(`sh -lc '${cmd.replace(/\n/g, ' ')}'`);
  }

  // 정규식 삭제: sed -E -e '/pattern/d' ... (패턴 배열을 모두 적용)
  async deleteByRegexPatterns(file: string, patterns: string[]) {
    if (!patterns?.length) return;
    const sedScripts = patterns.map((rx) => `-e ${q(`/${rx}/d`)}`).join(' ');
    const cmd = `sed -E -i ${sedScripts} "${file}"`;
    await connectionManager.run(`sh -lc '${cmd}'`);
  }

  async daemonReload() { await connectionManager.run(`sh -lc 'systemctl daemon-reload'`); }
   async restart() {
     await connectionManager.run(
       `sh -lc 'SYSTEMD_PAGER= systemctl restart --no-pager --no-ask-password ${q(this.unit)}'`,
     );
   }

  async contains(file: string, markerRe: string): Promise<boolean> {
    const { code } = await connectionManager.run(
      `sh -lc 'grep -E ${q(markerRe)} "${file}" >/dev/null 2>&1'`,
    );
    return (code ?? 1) === 0;
  }

  // alias
  async exists(file: string, markerRe: string): Promise<boolean> { return this.contains(file, markerRe); }

  async computeHash(file: string): Promise<string> {
    const { stdout } = await connectionManager.run(
      `sh -lc 'if command -v sha256sum >/dev/null 2>&1; then sha256sum ${q(file)} | cut -d" " -f1; else md5sum ${q(file)} | cut -d" " -f1; fi'`,
    );
    return String(stdout || '').trim();
  }
}

function esc(s: string) { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function q(s: string) { return `'${String(s).replace(/'/g, `'''`)}'`; }