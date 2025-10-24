// === src/extension/commands/CommandHandlersWorkspace.ts ===
import { execFile as execFileCb } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

import { changeWorkspaceBaseDir, resolveWorkspaceInfo } from '../../core/config/userdata.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';
import { ErrorCategory, XError } from '../../shared/errors.js';
import { RAW_DIR_NAME } from '../../shared/const.js';
import { PerfMonitorPanel } from '../editors/PerfMonitorPanel.js';
import { migrateParserConfigIfNeeded } from '../setup/parserConfigSeeder.js';

const log = getLogger('cmd.workspace');
const execFile = promisify(execFileCb);

export class CommandHandlersWorkspace {
  private workspaceInfoCache?: Awaited<ReturnType<typeof resolveWorkspaceInfo>>;
  private cacheExpiry = 0;
  private readonly CACHE_DURATION = 30000; // 30초 캐시

  constructor(
    private context?: vscode.ExtensionContext,
  ) {}

  // === 안내 팝업 없이 바로 폴더 선택(패널 버튼 전용)
  @measure()
  async changeWorkspaceQuick() {
    log.debug('[debug] CommandHandlersWorkspace changeWorkspaceQuick: start');
    if (!this.context) return log.error('[error] internal: no extension context');

    const startTime = Date.now();

    try {
      const prevInfo = await this.getCachedWorkspaceInfo(); // 변경 전
      log.debug(`[debug] changeWorkspaceQuick: prev ws=${prevInfo.wsDirUri.fsPath}`);
      // 캐시된 workspace 정보 사용 (불필요한 resolveWorkspaceInfo 호출 방지)
      const info = await this.getCachedWorkspaceInfo();

      // 폴더 선택 다이얼로그 (UI 병목 최소화)
      const sel = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select folder',
        title: '새 Workspace 베이스 폴더 선택 (그 하위에 workspace/가 생성됩니다)',
        defaultUri: info.baseDirUri,
      });

      if (!sel || !sel[0]) {
        log.debug('[debug] CommandHandlersWorkspace changeWorkspaceQuick: end');
        return;
      }

      const picked = sel[0].fsPath;
      const baseForConfig =
        path.basename(picked).toLowerCase() === 'workspace' ? path.dirname(picked) : picked;

      // 병렬 처리로 성능 향상: workspace 변경과 git init 동시에 수행
      const [updated] = await Promise.all([
        changeWorkspaceBaseDir(this.context, baseForConfig),
        // git init은 백그라운드에서 수행
        this.ensureGitInitAsync(baseForConfig),
      ]);

      // 변경 후 워크스페이스 정보 갱신
      this.workspaceInfoCache = undefined; // 강제 무효화
      const nextInfo = await this.getCachedWorkspaceInfo();
      log.debug(`[debug] changeWorkspaceQuick: next ws=${nextInfo.wsDirUri.fsPath}`);

      // 정책: 워크스페이스 변경 시 새 워크스페이스의 raw 폴더 제거
      try {
        const rawUri = vscode.Uri.joinPath(nextInfo.wsDirUri, RAW_DIR_NAME);
        await vscode.workspace.fs.delete(rawUri, { recursive: true, useTrash: false });
        log.info(`removed raw folder in new workspace: ${rawUri.fsPath}`);
      } catch {
        log.debug('no raw folder to remove in new workspace');
      }

      // .config 마이그레이션(새 ws에 없으면 이전 ws의 .config 복사, 둘 다 없으면 템플릿 시드)
      try {
        await migrateParserConfigIfNeeded(prevInfo.wsDirUri, nextInfo.wsDirUri, this.context!.extensionUri);
        log.debug('[debug] changeWorkspaceQuick: migration + old .config cleanup completed');
      } catch (e: any) { log.warn(`parser config migrate skipped: ${e?.message ?? e}`); }
      const duration = Date.now() - startTime;
      log.debug(`changeWorkspaceQuick completed in ${duration}ms`);
    } catch (e: any) {
      const duration = Date.now() - startTime;
      log.error(`changeWorkspaceQuick failed after ${duration}ms`, e);
    }
  }

  // === Workspace 열기: 항상 폴더 내부를 연다
  @measure()
  async openWorkspace() {
    log.debug('[debug] CommandHandlersWorkspace openWorkspace: start');
    if (!this.context) return log.error('[error] internal: no extension context');
    try {
      const info = await resolveWorkspaceInfo(this.context);
      await vscode.env.openExternal(info.wsDirUri);
      log.debug('[debug] CommandHandlersWorkspace openWorkspace: end');
    } catch (e: any) {
      log.error(`workspace open failed: ${e?.message || String(e)}`);
      vscode.window.showWarningMessage('Workspace가 아직 설정되지 않았습니다.');
    }
  }

  @measure()
  // (옵션) 현재 상태 확인용
  async showWorkspace() {
    log.debug('[debug] CommandHandlersWorkspace showWorkspace: start');
    if (!this.context) return log.error('[error] internal: no extension context');
    const info = await resolveWorkspaceInfo(this.context);
    if (info.source === 'user') {
      log.debug(`workspace (사용자 지정) base=${info.baseDirFsPath}`);
    } else {
      log.debug(`workspace (기본) base=${info.baseDirFsPath} (확장전용폴더)`);
    }
    log.debug(`-> 실제 사용 경로: ${info.wsDirFsPath}`);
  }

  // 캐시된 workspace 정보 조회
  @measure()
  private async getCachedWorkspaceInfo() {
    const now = Date.now();
    if (!this.workspaceInfoCache || now > this.cacheExpiry) {
      if (!this.context) throw new XError(ErrorCategory.Permission, 'no extension context');
      this.workspaceInfoCache = await resolveWorkspaceInfo(this.context);
      this.cacheExpiry = now + this.CACHE_DURATION;
    }
    return this.workspaceInfoCache;
  }

  @measure()
  // 비동기 git init (백그라운드 실행)
  private async ensureGitInitAsync(baseDir: string): Promise<void> {
    try {
      const wsDir =
        path.basename(baseDir).toLowerCase() === 'workspace'
          ? baseDir
          : path.join(baseDir, 'workspace');

      // 이미 .git 있으면 패스
      await vscode.workspace.fs.stat(vscode.Uri.file(path.join(wsDir, '.git')));
      return;
    } catch {}

    try {
      const wsDir =
        path.basename(baseDir).toLowerCase() === 'workspace'
          ? baseDir
          : path.join(baseDir, 'workspace');

      // 작업 디렉터리 보장(없어도 생성)
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(wsDir));

      log.debug(`git init in: ${wsDir}`);
      // shell을 통하지 않고 직접 git 실행 → Windows에서 cmd.exe ENOENT 회피
      await execFile('git', ['init'], { cwd: wsDir });
      log.debug('git init done');
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        log.error('git init failed: git executable not found on PATH (ENOENT)');
      } else {
        log.error(`git init failed: ${e?.message || String(e)}`);
      }
    }
  }

  @measure()
  async togglePerformanceMonitoring(extensionUri?: vscode.Uri) {
    log.debug('[debug] CommandHandlersWorkspace togglePerformanceMonitoring: start');
    if (!this.context || !extensionUri)
      return log.error('[error] internal: no context or extension uri');

    const panel = new PerfMonitorPanel(extensionUri, this.context);
    panel.createPanel();
    log.debug('[debug] CommandHandlersWorkspace togglePerformanceMonitoring: end');
  }
}
