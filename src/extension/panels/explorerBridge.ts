// === src/extension/panels/explorerBridge.ts ===
import * as vscode from 'vscode';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';

import { resolveWorkspaceInfo } from '../../core/config/userdata.js';
import { measure } from '../../core/logging/perf.js';
import { parentDir, relFromBase } from '../../shared/utils.js';
import { getStatusLiteFromDir } from '../../core/controller/GitController.js';
import {
  PARSER_CONFIG_REL,
  PARSER_README_REL,
  PARSER_TEMPLATE_REL,
  PARSER_README_TEMPLATE_REL,
  GITIGNORE_TEMPLATE_REL,
} from '../../shared/const.js';
const exec = promisify(execCb);

export type ExplorerBridge = {
  handleMessage(msg: any): Promise<boolean>;
  /** 워크스페이스 루트가 바뀌었을 때 워처를 갱신 */
  refreshWorkspaceRoot(): Promise<void>;
  /** .gitignore 스캐폴드 보장 + git add/commit (parser 초기화 버튼에서 호출) */
  ensureWorkspaceScaffoldAndCommit(): Promise<void>;
  dispose(): void;
};

// 숨김 필터 (간단 이름 기반)
const HIDE_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg']);
const HIDE_FILES = new Set(['.DS_Store', 'Thumbs.db']);

function shouldHideEntry(name: string, kind: 'file' | 'folder') {
  if (kind === 'folder') return HIDE_DIRS.has(name);
  return HIDE_FILES.has(name);
}

/** ──────────────────────────────────────────────────────────────────────
 *  코얼레서(스코프별 디바운스 + in-flight 가드)
 *  - 동일 스코프(예: '', 'raw', 'raw/merge_log')에 대한 list() 호출을
 *    100ms 윈도우 안에서 1회로 합치고, 진행 중이면 완료 후 마지막 요청만 1회 더 실행
 * ────────────────────────────────────────────────────────────────────── */
class RefreshCoalescer {
  private readonly DEBOUNCE_MS = 100;
  private timers = new Map<string, NodeJS.Timeout>();
  private inflight = new Set<string>();
  private pending = new Set<string>();
  constructor(private run: (scope: string) => Promise<void>) {}
  schedule(scope: string) {
    // 진행 중이면 펜딩만 표시(완료 시 한 번 더)
    if (this.inflight.has(scope)) {
      this.pending.add(scope);
      return;
    }
    // 디바운스 재시작
    if (this.timers.has(scope)) clearTimeout(this.timers.get(scope)!);
    this.timers.set(
      scope,
      setTimeout(async () => {
        this.timers.delete(scope);
        await this.execute(scope);
      }, this.DEBOUNCE_MS),
    );
  }
  @measure()
  private async execute(scope: string) {
    if (this.inflight.has(scope)) {
      this.pending.add(scope);
      return;
    }
    this.inflight.add(scope);
    try {
      await this.run(scope);
    } catch (e) {
    } finally {
      this.inflight.delete(scope);
      if (this.pending.has(scope)) {
        this.pending.delete(scope);
        // 완료 직후 짧게 한 번 더(연쇄 이벤트 누락 방지)
        setTimeout(() => this.execute(scope), 0);
      }
    }
  }
}

/** 워처 관리 상태 인터페이스(루트 1개만 보유) */
interface WatcherState {
  root?: vscode.FileSystemWatcher;
  cleanupTimer?: NodeJS.Timeout;
  git?: vscode.FileSystemWatcher;
}

/** 워처 관리 클래스 */
class WatcherManager {
  private state: WatcherState;
  private context: vscode.ExtensionContext;
  public info?: { wsDirUri: vscode.Uri };
  private disposed = false;
  // backing field for extension root uri (read-only via getter)
  private _extUri: vscode.Uri;
  private onFsHandler?: (
    relPath: string,
    uri: vscode.Uri,
    eventType: 'create' | 'change' | 'delete',
  ) => void;
  private onGitChange?: (uri: vscode.Uri) => void;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.state = {};
    // 확장 리소스 루트 URI 저장(읽기 전용)
    this._extUri = context.extensionUri;
    // 저장 시에도 Git 데코 갱신을 보장하기 위한 안전망:
    // 에디터에서 파일을 저장하면 change 이벤트처럼 처리하여 onFsHandler로 전달
    // (전역 구독은 한 번만 등록되도록 constructor에 둠)
    this.context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((d) => {
        this.onFsHandler?.('', d.uri, 'change');
      }),
    );
  }

  /** 확장 패키지 루트 URI (리소스 읽기용, read-only) */
  get extUri(): vscode.Uri {
    return this._extUri;
  }

  setOnFsHandler(
    handler: (relPath: string, uri: vscode.Uri, eventType: 'create' | 'change' | 'delete') => void,
  ) {
    this.onFsHandler = handler;
  }
  setOnGitChange(handler: (uri: vscode.Uri) => void) {
    this.onGitChange = handler;
  }
  /** 워크스페이스 정보 초기화 */
  @measure()
  async ensureInfo() {
    if (!this.info) {
      this.info = await resolveWorkspaceInfo(this.context);
      await this.ensureWatchers();
    }
    return this.info!;
  }

  /** 상대 경로를 URI로 변환 */
  toChildUri(base: vscode.Uri, rel: string) {
    const clean = String(rel || '')
      .replace(/^[\\/]+/, '')
      .replace(/\\/g, '/');
    const parts = clean.split('/').filter(Boolean);
    return vscode.Uri.joinPath(base, ...parts);
  }

  /** (축소) 루트 워처만 생성: create/delete만 수신, change는 무시 */
  private addRootWatcher(baseUri: vscode.Uri) {
    if (this.disposed || this.state.root) return;
    const pattern = new vscode.RelativePattern(baseUri.fsPath, '**/*');
    // create, delete만 받는다(변경 이벤트는 무시)
    const w = vscode.workspace.createFileSystemWatcher(
      pattern,
      /*ignoreCreate*/ false,
      /*ignoreChange*/ false,
      /*ignoreDelete*/ false,
    );
    this.state.root = w;
    if (this.onFsHandler) {
      const onCreate = (uri: vscode.Uri) => this.onFsHandler!('', uri, 'create');
      const onDelete = (uri: vscode.Uri) => this.onFsHandler!('', uri, 'delete');
      const onChange = (uri: vscode.Uri) => this.onFsHandler!('', uri, 'change');
      this.context.subscriptions.push(
        w.onDidCreate(onCreate),
        w.onDidDelete(onDelete),
        w.onDidChange(onChange),
      );
    }
    this.context.subscriptions.push(w);
  }

  /** .git 변경 전용 워처 (index/HEAD/refs 등 변경 감지) */
  private addGitWatcher(baseUri: vscode.Uri) {
    if (this.disposed || this.state.git) return;
    // 워크스페이스 기준으로 .git/** 내부의 변경을 감지
    const pattern = new vscode.RelativePattern(baseUri.fsPath, '.git/**');
    const w = vscode.workspace.createFileSystemWatcher(
      pattern,
      /*ignoreCreate*/ true,
      /*ignoreChange*/ false,
      /*ignoreDelete*/ true,
    );
    this.state.git = w;
    if (this.onGitChange) {
      const onChange = (uri: vscode.Uri) => this.onGitChange!(uri);
      this.context.subscriptions.push(w.onDidChange(onChange));
    }
    this.context.subscriptions.push(w);
  }
  /** 워처 초기화 및 재등록 */
  @measure()
  async ensureWatchers() {
    if (this.disposed || !this.info) return;
    const baseUri = this.info.wsDirUri;
    const baseFsPath = baseUri.fsPath;
    // 기존 루트 워처 해제
    try {
      this.state.root?.dispose();
    } catch {}
    this.state.root = undefined;
    // 루트 / Git 워처 재등록
    this.addRootWatcher(baseUri);
    this.addGitWatcher(baseUri);
  }

  /** 주기적 정리 */
  @measure()
  async cleanup() {
    if (this.disposed || !this.info) return;
    // 루트만 관리하므로 보정 작업 없음. 워크스페이스 경로 변경만 재보장
    await this.ensureWatchers();
  }

  /** 타이머 시작 */
  startCleanupTimer() {
    this.state.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /** dispose */
  @measure()
  dispose() {
    this.disposed = true;
    if (this.state.cleanupTimer) {
      clearInterval(this.state.cleanupTimer);
      this.state.cleanupTimer = undefined;
    }
    if (this.state.root) {
      try {
        this.state.root.dispose();
      } catch (e) {}
      this.state.root = undefined;
    }
    if (this.state.git) {
      try {
        this.state.git.dispose();
      } catch (e) {}
      this.state.git = undefined;
    }
  }

  // 하위 호환(더 이상 사용하지 않음)
  get watchers() {
    return new Map<string, vscode.FileSystemWatcher>();
  }
  get wsDirUri() {
    return this.info?.wsDirUri;
  }
}

/** UI 관리 클래스 */
class ExplorerUI {
  private post: (msg: any) => void;
  private watcherManager: WatcherManager;
  private coalescer: RefreshCoalescer;
  private gitTimer?: NodeJS.Timeout;

  constructor(post: (msg: any) => void, watcherManager: WatcherManager) {
    this.post = post;
    this.watcherManager = watcherManager;
    // scope → list() 코얼레싱 실행기
    this.coalescer = new RefreshCoalescer(async (scope) => {
      await this.list(scope);
    });
  }

  // ────────────────────────────────────────────────────────────
  // Workspace Scaffold (.gitignore + custom_log_parser)
  // ────────────────────────────────────────────────────────────
  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureDir(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(uri);
    } catch {}
  }

  /** 확장 패키지 내 임베디드 리소스를 읽어 텍스트로 반환 */
  private async readEmbedded(rel: string): Promise<Uint8Array> {
    const base = this.watcherManager.extUri;
    const parts = rel.split('/').filter(Boolean);
    const src = vscode.Uri.joinPath(base, ...parts);
    return await vscode.workspace.fs.readFile(src);
  }

  /**
   * 워크스페이스 루트 기준 relTarget에 파일이 없으면 embeddedRel에서 복사
   * @returns true면 새로 생성됨, false면 이미 있었거나 실패
   */
  private async writeFromTemplate(relTarget: string, embeddedRel: string): Promise<boolean> {
    if (!this.watcherManager.wsDirUri) {
      await this.watcherManager.ensureInfo();
    }
    const ws = this.watcherManager.wsDirUri!;
    const segs = relTarget.split('/').filter(Boolean);
    const target = vscode.Uri.joinPath(ws, ...segs);

     if (await this.exists(target)) return false; // 이미 있으면 스킵

    // 부모 디렉터리 보장
    if (segs.length > 1) {
      const dir = vscode.Uri.joinPath(ws, ...segs.slice(0, -1));
      await this.ensureDir(dir);
    }

    try {
      const buf = await this.readEmbedded(embeddedRel);
      await vscode.workspace.fs.writeFile(target, buf);
      return true;
    } catch {
      // 템플릿이 없거나 쓰기 실패해도 조용히 스킵 (요청한 "안되면 그대로" 동작)
      return false;
    }
  }

  /**
   * git 초기화/커밋 보조:
   * - 레포가 아니면 git init
   * - .gitignore add 후 "[Do not push] add gitignore" 커밋 (변경 없으면 조용히 통과)
   */
  private async ensureGitInitAddCommit(wsDirUri: vscode.Uri): Promise<void> {
    const cwd = wsDirUri.fsPath;
    try {
      // 레포 여부 확인
      let isRepo = true;
      try {
        const { stdout } = await exec('git rev-parse --is-inside-work-tree', { cwd });
        isRepo = /^true/i.test(String(stdout).trim());
      } catch {
        isRepo = false;
      }
      if (!isRepo) {
        await exec('git init', { cwd });
      }
      // add & commit (변경 없으면 commit에서 예외가 날 수 있으니 무시)
      await exec('git add .gitignore', { cwd });
      try {
        await exec('git commit -m "[Do not push] add gitignore"', { cwd });
      } catch {
        // 커밋할 변경 없음 → 무시
      }
    } catch {
      // git이 아예 없거나 오류 → 조용히 스킵 (요구사항: 가능하면 수행)
    }
  }

  /** 워크스페이스 스캐폴딩: .gitignore + custom_log_parser(설명서 포함) */
  private async ensureWorkspaceScaffold(forceCommit = false): Promise<void> {
    try {
      // 1) .gitignore (존재하지 않을 때만 생성)
      const createdGitignore = await this.writeFromTemplate('.gitignore', GITIGNORE_TEMPLATE_REL);

      // 2) custom_log_parser (존재하지 않을 때만)
      await this.writeFromTemplate(PARSER_CONFIG_REL, PARSER_TEMPLATE_REL);
      await this.writeFromTemplate(PARSER_README_REL, PARSER_README_TEMPLATE_REL);

      // 3) git add/commit 규칙:
      //    - .gitignore를 새로 복사한 경우
      //    - 혹은 parser 초기화 등에서 강제 커밋이 요청된 경우(forceCommit)
      if (!this.watcherManager.wsDirUri) {
        await this.watcherManager.ensureInfo();
      }
      const ws = this.watcherManager.wsDirUri!;
      if (createdGitignore || forceCommit) {
        await this.ensureGitInitAddCommit(ws);
      }
    } catch {
      // 전체 스캐폴드 실패는 무시 (개별 writeFromTemplate에서 이미 스킵 처리)
    }
  }

  /** 파일 시스템 이벤트 처리 */
  @measure()
  async handleFsEvent(relPath: string, uri: vscode.Uri, eventType: 'create' | 'change' | 'delete') {
    // 워크스페이스 정보가 없으면 초기화
    if (!this.watcherManager.wsDirUri) {
      await this.watcherManager.ensureInfo();
      // ▶ 루트 갱신 시 스캐폴드 보장(.gitignore / custom_log_parser) + 필요 시 커밋
      await this.ensureWorkspaceScaffold(false);
    }
    const baseFsPath = this.watcherManager.wsDirUri!.fsPath;
    const rel = relFromBase(baseFsPath, uri);
    const dir = parentDir(rel);
    const top = dir.split('/').filter(Boolean)[0] ?? rel.split('/').filter(Boolean)[0] ?? '';
    if (HIDE_DIRS.has(top)) return;
    if (eventType === 'change') {
      // 내용 변경은 트리 목록 변화가 없으므로 Git 요약만 갱신(150ms 디바운스)
      this.scheduleGitStatus();
      return;
    }
    // create/delete → 해당 디렉터리 스코프만 갱신 + Git 요약도 갱신
    const scope = parentDir(rel);
    this.coalescer.schedule(scope);
    this.scheduleGitStatus();
  }

  // (삭제/폴더 추가에 대한 별도 워처 추가/제거 로직은 제거됨: 루트 워처 + list()만으로 반영)

  /** 메시지 처리 */
  @measure()
  async handleMessage(msg: any): Promise<boolean> {
    switch (msg.type) {
      case 'explorer.list':
        await this.list(String(msg.payload?.path || ''));
        return true;
      case 'explorer.refresh':
        // 수동 새로고침: 즉시 해당 스코프 list()
        await this.list(String(msg.payload?.path || ''));
        return true;
      case 'explorer.open':
        await this.open(String(msg.payload?.path || ''));
        return true;
      case 'explorer.createFile':
        await this.createFile(String(msg.payload?.path || ''));
        return true;
      case 'explorer.createFolder':
        await this.createFolder(String(msg.payload?.path || ''));
        return true;
      case 'explorer.delete':
        await this.remove(
          String(msg.payload?.path || ''),
          !!msg.payload?.recursive,
          !!msg.payload?.useTrash,
        );
        return true;
    }
    return false;
  }

  /** .git 내부 변경 시 호출: Git 요약만 디바운스 갱신 */
  @measure()
  async handleGitEvent(_uri: vscode.Uri) {
    this.scheduleGitStatus();
  }

  /** Git 상태를 디바운스(150ms)로 웹뷰에 푸시 */
  private scheduleGitStatus() {
    if (this.gitTimer) clearTimeout(this.gitTimer);
    this.gitTimer = setTimeout(async () => {
      this.gitTimer = undefined;
      await this.postGitStatus();
    }, 150);
  }

  /** 현재 워크스페이스의 경량 Git 상태 계산 후 송신 */
  @measure()
  private async postGitStatus() {
    try {
      if (!this.watcherManager.wsDirUri) {
        await this.watcherManager.ensureInfo();
      }
      const wsDirFs = this.watcherManager.wsDirUri!.fsPath;
      const status = await getStatusLiteFromDir(wsDirFs);
      this.post({ v: 1, type: 'git.status.response', payload: { status } });
    } catch (e: any) {
      this.post({
        v: 1,
        type: 'git.status.error',
        payload: { message: e?.message || String(e) },
      });
    }
  }

  @measure()
  private async list(rel: string) {
    try {
      // 워크스페이스 정보가 없으면 초기화
      if (!this.watcherManager.wsDirUri) {
        await this.watcherManager.ensureInfo();
      }
      const wsDirUri = this.watcherManager.wsDirUri!;
      const dirUri = this.watcherManager.toChildUri(wsDirUri, rel);

      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      const items = entries
        .filter(([name, t]) => {
          const kind =
            t === vscode.FileType.Directory
              ? 'folder'
              : t === vscode.FileType.File
                ? 'file'
                : 'other';
          if (kind === 'other') return false;
          return !shouldHideEntry(name, kind as 'file' | 'folder');
        })
        .map(([name, t]) => ({
          name,
          kind: t === vscode.FileType.Directory ? 'folder' : ('file' as const),
        }));
      this.post({ v: 1, type: 'explorer.list.result', payload: { path: rel || '', items } });
    } catch (e: any) {
      this.post({
        v: 1,
        type: 'explorer.error',
        payload: { op: 'list', message: e?.message || String(e) },
      });
    }
  }

  @measure()
  private async open(rel: string) {
    try {
      // 워크스페이스 정보가 없으면 초기화
      if (!this.watcherManager.wsDirUri) {
        await this.watcherManager.ensureInfo();
      }
      const wsDirUri = this.watcherManager.wsDirUri!;
      const uri = this.watcherManager.toChildUri(wsDirUri, rel);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      this.post({ v: 1, type: 'explorer.ok', payload: { op: 'open', path: rel || '' } });
    } catch (e: any) {
      this.post({
        v: 1,
        type: 'explorer.error',
        payload: { op: 'open', message: e?.message || String(e) },
      });
    }
  }

  @measure()
  private async createFile(rel: string) {
    try {
      // 워크스페이스 정보가 없으면 초기화
      if (!this.watcherManager.wsDirUri) {
        await this.watcherManager.ensureInfo();
      }
      const wsDirUri = this.watcherManager.wsDirUri!;
      const uri = this.watcherManager.toChildUri(wsDirUri, rel);
      await vscode.workspace.fs.writeFile(uri, new Uint8Array());
      this.post({ v: 1, type: 'explorer.ok', payload: { op: 'createFile', path: rel || '' } });
    } catch (e: any) {
      this.post({
        v: 1,
        type: 'explorer.error',
        payload: { op: 'createFile', message: e?.message || String(e) },
      });
    }
  }

  @measure()
  private async createFolder(rel: string) {
    try {
      // 워크스페이스 정보가 없으면 초기화
      if (!this.watcherManager.wsDirUri) {
        await this.watcherManager.ensureInfo();
      }
      const wsDirUri = this.watcherManager.wsDirUri!;
      const uri = this.watcherManager.toChildUri(wsDirUri, rel);
      await vscode.workspace.fs.createDirectory(uri);
      this.post({ v: 1, type: 'explorer.ok', payload: { op: 'createFolder', path: rel || '' } });
    } catch (e: any) {
      this.post({
        v: 1,
        type: 'explorer.error',
        payload: { op: 'createFolder', message: e?.message || String(e) },
      });
    }
  }

  @measure()
  private async remove(rel: string, recursive: boolean, useTrash: boolean) {
    try {
      // 워크스페이스 정보가 없으면 초기화
      if (!this.watcherManager.wsDirUri) {
        await this.watcherManager.ensureInfo();
      }
      const wsDirUri = this.watcherManager.wsDirUri!;
      const uri = this.watcherManager.toChildUri(wsDirUri, rel);
      await vscode.workspace.fs.delete(uri, { recursive, useTrash });

      this.post({ v: 1, type: 'explorer.ok', payload: { op: 'delete', path: rel || '' } });
    } catch (e: any) {
      this.post({
        v: 1,
        type: 'explorer.error',
        payload: { op: 'delete', message: e?.message || String(e) },
      });
    }
  }

  /** 워크스페이스 루트 변경 */
  @measure()
  async refreshWorkspaceRoot() {
    this.watcherManager.info = undefined;
    await this.watcherManager.ensureInfo();
    // ✅ 워크스페이스 루트가 바뀌면 .gitignore/파서 템플릿 보장
    await this.ensureWorkspaceScaffold(false);
    // ✅ Git 상태도 갱신(웹뷰 배지 즉시 반영)
    await this.postGitStatus();
    this.post({ v: 1, type: 'explorer.root.changed', payload: {} });
  }

  /** Parser 초기화 버튼에서 호출: .gitignore 생성 보장 + git add/commit */
  @measure()
  async ensureWorkspaceScaffoldAndCommit() {
    if (!this.watcherManager.wsDirUri) {
      await this.watcherManager.ensureInfo();
    }
    await this.ensureWorkspaceScaffold(true);
    // Git 상태 패널도 갱신
    await this.postGitStatus();
  }
}

export function createExplorerBridge(
  context: vscode.ExtensionContext,
  post: (m: any) => void,
): ExplorerBridge {
  const watcherManager = new WatcherManager(context);
  const explorerUI = new ExplorerUI(post, watcherManager);

  watcherManager.setOnFsHandler(explorerUI.handleFsEvent.bind(explorerUI));
  watcherManager.setOnGitChange(explorerUI.handleGitEvent.bind(explorerUI));

  watcherManager.startCleanupTimer();

  return {
    async handleMessage(msg: any) {
      return await explorerUI.handleMessage(msg);
    },
    async refreshWorkspaceRoot() {
      await explorerUI.refreshWorkspaceRoot();
    },
    async ensureWorkspaceScaffoldAndCommit() {
      await explorerUI.ensureWorkspaceScaffoldAndCommit();
    },
    dispose() {
      watcherManager.dispose();
    },
  };
}
