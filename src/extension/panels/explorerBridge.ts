// === src/extension/panels/explorerBridge.ts ===
import * as vscode from 'vscode';

import { resolveWorkspaceInfo } from '../../core/config/userdata.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { parentDir, relFromBase, toPosix } from '../../shared/utils.js';

export type ExplorerBridge = {
  handleMessage(msg: any): Promise<boolean>;
  /** 워크스페이스 루트가 바뀌었을 때 워처를 갱신 */
  refreshWorkspaceRoot(): Promise<void>;
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
 *    150ms 윈도우 안에서 1회로 합치고, 진행 중이면 완료 후 마지막 요청만 1회 더 실행
 * ────────────────────────────────────────────────────────────────────── */
class RefreshCoalescer {
  private readonly log = getLogger('extension:panels:Coalescer');
  private readonly DEBOUNCE_MS = 150;
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
  private async execute(scope: string) {
    if (this.inflight.has(scope)) {
      this.pending.add(scope);
      return;
    }
    this.inflight.add(scope);
    try {
      await this.run(scope);
    } catch (e) {
      this.log.warn(`list(${scope}) failed: ${e instanceof Error ? e.message : String(e)}`);
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
}

/** 워처 관리 클래스 */
class WatcherManager {
  private log = getLogger('extension:panels:WatcherManager');
  private state: WatcherState;
  private context: vscode.ExtensionContext;
  public info?: { wsDirUri: vscode.Uri };
  private disposed = false;
  private onFsHandler?: (
    relPath: string,
    uri: vscode.Uri,
    eventType: 'create' | 'change' | 'delete',
  ) => void;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.state = {};
  }

  setOnFsHandler(
    handler: (relPath: string, uri: vscode.Uri, eventType: 'create' | 'change' | 'delete') => void,
  ) {
    this.onFsHandler = handler;
  }

  /** 워크스페이스 정보 초기화 */
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
      /*ignoreChange*/ true,
      /*ignoreDelete*/ false,
    );
    this.state.root = w;
    this.log.info('[WatcherManager] adding root watcher for workspace');
    if (this.onFsHandler) {
      const onCreate = (uri: vscode.Uri) => this.onFsHandler!('', uri, 'create');
      const onDelete = (uri: vscode.Uri) => this.onFsHandler!('', uri, 'delete');
      // change 무시
      this.context.subscriptions.push(w.onDidCreate(onCreate), w.onDidDelete(onDelete));
    }
    this.context.subscriptions.push(w);
  }

  /** 워처 초기화 및 재등록 */
  async ensureWatchers() {
    if (this.disposed || !this.info) return;
    const baseUri = this.info.wsDirUri;
    const baseFsPath = baseUri.fsPath;
    // 기존 루트 워처 해제
    try {
      this.state.root?.dispose();
    } catch {}
    this.state.root = undefined;
    // 루트 워처만 재등록
    this.addRootWatcher(baseUri);
    this.log.info('[WatcherManager] watchers initialized for workspace root:', toPosix(baseFsPath));
  }

  /** 주기적 정리 */
  async cleanup() {
    if (this.disposed || !this.info) return;
    this.log.info('[WatcherManager] starting periodic watcher cleanup');
    // 루트만 관리하므로 보정 작업 없음. 워크스페이스 경로 변경만 재보장
    await this.ensureWatchers();
    this.log.info('[WatcherManager] periodic watcher cleanup completed');
  }

  /** 타이머 시작 */
  startCleanupTimer() {
    this.state.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /** dispose */
  dispose() {
    this.disposed = true;
    if (this.state.cleanupTimer) {
      clearInterval(this.state.cleanupTimer);
      this.state.cleanupTimer = undefined;
    }
    if (this.state.root) {
      this.log.info('[WatcherManager] disposing root watcher on dispose');
      try {
        this.state.root.dispose();
      } catch (e) {
        this.log.error('[WatcherManager] watcher dispose error', e);
      }
      this.state.root = undefined;
    }
    this.log.info('[WatcherManager] all watchers disposed');
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
  private log = getLogger('extension:panels:ExplorerUI');
  private post: (msg: any) => void;
  private watcherManager: WatcherManager;
  private coalescer: RefreshCoalescer;

  constructor(post: (msg: any) => void, watcherManager: WatcherManager) {
    this.post = post;
    this.watcherManager = watcherManager;
    // scope → list() 코얼레싱 실행기
    this.coalescer = new RefreshCoalescer(async (scope) => {
      await this.list(scope);
    });
  }

  /** 파일 시스템 이벤트 처리 */
  async handleFsEvent(relPath: string, uri: vscode.Uri, eventType: 'create' | 'change' | 'delete') {
    // change 이벤트는 루트 워처 단계에서 무시되지만 혹시 모를 케이스 방어
    if (eventType === 'change') return;
    // 워크스페이스 정보가 없으면 초기화
    if (!this.watcherManager.wsDirUri) {
      await this.watcherManager.ensureInfo();
    }
    const baseFsPath = this.watcherManager.wsDirUri!.fsPath;
    const rel = relFromBase(baseFsPath, uri);
    const dir = parentDir(rel);
    const top = dir.split('/').filter(Boolean)[0] ?? rel.split('/').filter(Boolean)[0] ?? '';
    if (HIDE_DIRS.has(top)) return;

    this.log.info(
      '[ExplorerUI] fs event',
      eventType,
      'in folder',
      relPath,
      ':',
      uri.fsPath,
      'rel:',
      rel,
    );
    // create/delete → 해당 디렉터리 스코프만 갱신
    const scope = parentDir(rel);
    this.coalescer.schedule(scope);
  }

  // (삭제/폴더 추가에 대한 별도 워처 추가/제거 로직은 제거됨: 루트 워처 + list()만으로 반영)

  /** 메시지 처리 */
  async handleMessage(msg: any): Promise<boolean> {
    switch (msg.type) {
      case 'explorer.list':
        this.log.info('[ExplorerUI] <- list', msg.payload?.path);
        await this.list(String(msg.payload?.path || ''));
        return true;
      case 'explorer.refresh':
        // 수동 새로고침: 즉시 해당 스코프 list()
        this.log.info('[ExplorerUI] <- refresh', msg.payload?.path);
        await this.list(String(msg.payload?.path || ''));
        return true;
      case 'explorer.open':
        this.log.info('[ExplorerUI] <- open', msg.payload?.path);
        await this.open(String(msg.payload?.path || ''));
        return true;
      case 'explorer.createFile':
        this.log.info('[ExplorerUI] <- createFile', msg.payload?.path);
        await this.createFile(String(msg.payload?.path || ''));
        return true;
      case 'explorer.createFolder':
        this.log.info('[ExplorerUI] <- createFolder', msg.payload?.path);
        await this.createFolder(String(msg.payload?.path || ''));
        return true;
      case 'explorer.delete':
        this.log.info('[ExplorerUI] <- delete', msg.payload?.path, {
          recursive: !!msg.payload?.recursive,
          useTrash: !!msg.payload?.useTrash,
        });
        await this.remove(
          String(msg.payload?.path || ''),
          !!msg.payload?.recursive,
          !!msg.payload?.useTrash,
        );
        return true;
    }
    return false;
  }

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
      this.log.info('[ExplorerUI] list', rel, '->', items.length, 'items');
      this.post({ v: 1, type: 'explorer.list.result', payload: { path: rel || '', items } });
    } catch (e: any) {
      this.log.error(`list error for ${rel}: ${e?.message || String(e)}`);
      this.post({
        v: 1,
        type: 'explorer.error',
        payload: { op: 'list', message: e?.message || String(e) },
      });
    }
  }

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
      this.log.info('[ExplorerUI] open', rel);
      this.post({ v: 1, type: 'explorer.ok', payload: { op: 'open', path: rel || '' } });
    } catch (e: any) {
      this.log.error(`open error for ${rel}: ${e?.message || String(e)}`);
      this.post({
        v: 1,
        type: 'explorer.error',
        payload: { op: 'open', message: e?.message || String(e) },
      });
    }
  }

  private async createFile(rel: string) {
    try {
      // 워크스페이스 정보가 없으면 초기화
      if (!this.watcherManager.wsDirUri) {
        await this.watcherManager.ensureInfo();
      }
      const wsDirUri = this.watcherManager.wsDirUri!;
      const uri = this.watcherManager.toChildUri(wsDirUri, rel);
      await vscode.workspace.fs.writeFile(uri, new Uint8Array());
      this.log.info('[ExplorerUI] createFile', rel);
      this.post({ v: 1, type: 'explorer.ok', payload: { op: 'createFile', path: rel || '' } });
    } catch (e: any) {
      this.log.error(`createFile error for ${rel}: ${e?.message || String(e)}`);
      this.post({
        v: 1,
        type: 'explorer.error',
        payload: { op: 'createFile', message: e?.message || String(e) },
      });
    }
  }

  private async createFolder(rel: string) {
    try {
      // 워크스페이스 정보가 없으면 초기화
      if (!this.watcherManager.wsDirUri) {
        await this.watcherManager.ensureInfo();
      }
      const wsDirUri = this.watcherManager.wsDirUri!;
      const uri = this.watcherManager.toChildUri(wsDirUri, rel);
      await vscode.workspace.fs.createDirectory(uri);
      this.log.info('[ExplorerUI] createFolder', rel);
      this.post({ v: 1, type: 'explorer.ok', payload: { op: 'createFolder', path: rel || '' } });
    } catch (e: any) {
      this.log.error(`createFolder error for ${rel}: ${e?.message || String(e)}`);
      this.post({
        v: 1,
        type: 'explorer.error',
        payload: { op: 'createFolder', message: e?.message || String(e) },
      });
    }
  }

  private async remove(rel: string, recursive: boolean, useTrash: boolean) {
    try {
      // 워크스페이스 정보가 없으면 초기화
      if (!this.watcherManager.wsDirUri) {
        await this.watcherManager.ensureInfo();
      }
      const wsDirUri = this.watcherManager.wsDirUri!;
      const uri = this.watcherManager.toChildUri(wsDirUri, rel);
      await vscode.workspace.fs.delete(uri, { recursive, useTrash });
      this.log.info('[ExplorerUI] delete', rel, { recursive, useTrash });

      this.post({ v: 1, type: 'explorer.ok', payload: { op: 'delete', path: rel || '' } });
    } catch (e: any) {
      this.log.error(`delete error for ${rel}: ${e?.message || String(e)}`);
      this.post({
        v: 1,
        type: 'explorer.error',
        payload: { op: 'delete', message: e?.message || String(e) },
      });
    }
  }

  /** 워크스페이스 루트 변경 */
  async refreshWorkspaceRoot() {
    this.watcherManager.info = undefined;
    await this.watcherManager.ensureInfo();
    this.post({ v: 1, type: 'explorer.root.changed', payload: {} });
  }
}

export function createExplorerBridge(
  context: vscode.ExtensionContext,
  post: (m: any) => void,
): ExplorerBridge {
  const log = getLogger('extension:panels:explorerBridge');
  const watcherManager = new WatcherManager(context);
  const explorerUI = new ExplorerUI(post, watcherManager);

  watcherManager.setOnFsHandler(explorerUI.handleFsEvent.bind(explorerUI));

  watcherManager.startCleanupTimer();

  return {
    async handleMessage(msg: any) {
      return await explorerUI.handleMessage(msg);
    },
    async refreshWorkspaceRoot() {
      await explorerUI.refreshWorkspaceRoot();
    },
    dispose() {
      watcherManager.dispose();
    },
  };
}
