// === src/extension/panels/explorerBridge.ts ===
import * as vscode from 'vscode';
import { resolveWorkspaceInfo } from '../../core/config/userdata.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { toPosix, relFromBase, parentDir } from '../../shared/utils.js';

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

/** 워처 관리 상태 인터페이스 */
interface WatcherState {
  watchers: Map<string, vscode.FileSystemWatcher>;
  cleanupTimer?: NodeJS.Timeout;
}

/** 워처 관리 클래스 */
class WatcherManager {
  private log = getLogger('extension:panels:WatcherManager');
  private state: WatcherState;
  private context: vscode.ExtensionContext;
  public info?: { wsDirUri: vscode.Uri };
  private disposed = false;
  private onFsHandler?: (relPath: string, uri: vscode.Uri, eventType: 'create' | 'change' | 'delete') => void;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.state = { watchers: new Map() };
  }

  setOnFsHandler(handler: (relPath: string, uri: vscode.Uri, eventType: 'create' | 'change' | 'delete') => void) {
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
    const clean = String(rel || '').replace(/^[\\/]+/, '').replace(/\\/g, '/');
    const parts = clean.split('/').filter(Boolean);
    return vscode.Uri.joinPath(base, ...parts);
  }

  /** 워처 추가 */
  addWatcher(relPath: string, folderUri: vscode.Uri) {
    if (this.disposed || this.state.watchers.has(relPath)) {
      this.log.info('watcher already exists or disposed for folder:', relPath);
      return;
    }

    const pattern = new vscode.RelativePattern(folderUri.fsPath, '**/*');
    const w = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
    this.state.watchers.set(relPath, w);

    this.log.info('adding watcher for folder:', relPath, 'at path:', folderUri.fsPath);

    // 이벤트 핸들러 바인딩
    if (this.onFsHandler) {
      const onFs = (uri: vscode.Uri) => this.onFsHandler!(relPath, uri, 'create');
      const onChange = (uri: vscode.Uri) => this.onFsHandler!(relPath, uri, 'change');
      const onDelete = (uri: vscode.Uri) => this.onFsHandler!(relPath, uri, 'delete');
      this.context.subscriptions.push(w.onDidCreate(onFs), w.onDidChange(onChange), w.onDidDelete(onDelete));
    }

    this.context.subscriptions.push(w);
    this.log.info('[WatcherManager] watcher added for folder:', relPath);
  }

  /** 워처 제거 */
  removeWatcher(relPath: string) {
    const w = this.state.watchers.get(relPath);
    if (w) {
      this.log.info('[WatcherManager] removing watcher for folder:', relPath);
      try { w.dispose(); } catch (e) { this.log.error('[WatcherManager] watcher dispose error for', relPath, e); }
      this.state.watchers.delete(relPath);
      this.log.info('[WatcherManager] watcher removed for folder:', relPath);
    } else {
      this.log.info('[WatcherManager] no watcher found to remove for folder:', relPath);
    }
  }

  /** 워처 초기화 및 재등록 */
  async ensureWatchers() {
    if (this.disposed || !this.info) return;
    const baseUri = this.info.wsDirUri;
    const baseFsPath = baseUri.fsPath;

    // 기존 워처 해제
    for (const [path, w] of this.state.watchers) {
      try { w.dispose(); } catch {}
    }
    this.state.watchers.clear();

    // 루트 워처 추가
    this.log.info('[WatcherManager] adding root watcher for workspace');
    this.addWatcher('', baseUri);

    // 기존 폴더 스캔
    try {
      const entries = await vscode.workspace.fs.readDirectory(baseUri);
      for (const [name, type] of entries) {
        if (type === vscode.FileType.Directory && !shouldHideEntry(name, 'folder')) {
          const folderRel = name;
          const folderUri = vscode.Uri.joinPath(baseUri, name);
          this.log.info('[WatcherManager] initializing watcher for existing folder:', folderRel);
          this.addWatcher(folderRel, folderUri);
        }
      }
    } catch (e) {
      this.log.error('[WatcherManager] initial folder scan error', e);
    }

    this.log.info('[WatcherManager] watchers initialized for workspace root:', toPosix(baseFsPath));
  }

  /** 주기적 정리 */
  async cleanup() {
    if (this.disposed || !this.info) return;
    this.log.info('[WatcherManager] starting periodic watcher cleanup');
    const beforeCount = this.state.watchers.size;

    const toRemove: string[] = [];
    for (const [relPath] of this.state.watchers) {
      if (relPath === '') continue;
      const uri = this.toChildUri(this.info.wsDirUri, relPath);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        toRemove.push(relPath);
      }
    }
    for (const relPath of toRemove) {
      this.removeWatcher(relPath);
    }

    const afterCount = this.state.watchers.size;
    this.log.info(`[WatcherManager] cleanup removed ${beforeCount - afterCount} watchers, now ${afterCount}`);

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
    for (const [path, w] of this.state.watchers) {
      this.log.info('[WatcherManager] disposing watcher for folder:', path, 'on dispose');
      try { w.dispose(); } catch (e) { this.log.error('[WatcherManager] watcher dispose error', e); }
    }
    this.state.watchers.clear();
    this.log.info('[WatcherManager] all watchers disposed');
  }

  get watchers() { return this.state.watchers; }
  get wsDirUri() { return this.info?.wsDirUri; }
}

/** UI 관리 클래스 */
class ExplorerUI {
  private log = getLogger('extension:panels:ExplorerUI');
  private post: (msg: any) => void;
  private watcherManager: WatcherManager;

  constructor(post: (msg: any) => void, watcherManager: WatcherManager) {
    this.post = post;
    this.watcherManager = watcherManager;
  }

  /** 파일 시스템 이벤트 처리 */
  async handleFsEvent(relPath: string, uri: vscode.Uri, eventType: 'create' | 'change' | 'delete') {
    const baseFsPath = this.watcherManager.wsDirUri!.fsPath;
    const rel = relFromBase(baseFsPath, uri);
    const dir = parentDir(rel);
    const top = dir.split('/').filter(Boolean)[0] ?? rel.split('/').filter(Boolean)[0] ?? '';
    if (HIDE_DIRS.has(top)) return;

    this.log.info('[ExplorerUI] fs event', eventType, 'in folder', relPath, ':', uri.fsPath, 'rel:', rel);

    if (eventType === 'create' || eventType === 'change') {
      await this.handleCreateOrChange(relPath, uri, rel);
    } else if (eventType === 'delete') {
      await this.handleDelete(relPath, uri, rel);
    }

    this.notifyUIChange(relPath, rel);
  }

  private async handleCreateOrChange(relPath: string, uri: vscode.Uri, rel: string) {
    const baseFsPath = this.watcherManager.wsDirUri!.fsPath;

    // 폴더 생성 감지
    if (relPath === '' && uri.fsPath.startsWith(this.watcherManager.wsDirUri!.fsPath)) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type === vscode.FileType.Directory) {
          const newRel = relFromBase(baseFsPath, uri);
          this.log.info('[ExplorerUI] detected folder creation:', newRel, 'adding watcher');
          this.watcherManager.addWatcher(newRel, uri);
        }
      } catch {}
    }

    // 새 폴더 내 파일 감지
    if (relPath === '' && rel.includes('/')) {
      const parentRel = parentDir(rel);
      if (!this.watcherManager.watchers.has(parentRel)) {
        const parentUri = this.watcherManager.toChildUri(this.watcherManager.wsDirUri!, parentRel);
        this.log.info('[ExplorerUI] detected new folder from file:', parentRel, 'adding watcher');
        this.watcherManager.addWatcher(parentRel, parentUri);
        this.post({ type: 'explorer.fs.changed', path: '' });
      }
    }
  }

  private async handleDelete(relPath: string, uri: vscode.Uri, rel: string) {
    this.watcherManager.removeWatcher(rel);

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory) {
        this.log.info('[ExplorerUI] confirmed folder deletion:', rel);
      } else {
        this.log.debug('[ExplorerUI] file deletion detected:', rel);
      }
    } catch {}
  }

  private notifyUIChange(relPath: string, rel: string) {
    if (relPath !== '') {
      this.post({ type: 'explorer.fs.changed', path: rel });
    } else {
      const parentDirPath = parentDir(rel);
      this.post({ type: 'explorer.fs.changed', path: parentDirPath });
    }
  }

  /** 메시지 처리 */
  async handleMessage(msg: any): Promise<boolean> {
    switch (msg.type) {
      case 'explorer.list':
        this.log.info('[ExplorerUI] <- list', msg.path);
        await this.list(String(msg.path || ''));
        return true;
      case 'explorer.open':
        this.log.info('[ExplorerUI] <- open', msg.path);
        await this.open(String(msg.path || ''));
        return true;
      case 'explorer.createFile':
        this.log.info('[ExplorerUI] <- createFile', msg.path);
        await this.createFile(String(msg.path || ''));
        return true;
      case 'explorer.createFolder':
        this.log.info('[ExplorerUI] <- createFolder', msg.path);
        await this.createFolder(String(msg.path || ''));
        return true;
      case 'explorer.delete':
        this.log.info('[ExplorerUI] <- delete', msg.path, { recursive: !!msg.recursive, useTrash: !!msg.useTrash });
        await this.remove(String(msg.path || ''), !!msg.recursive, !!msg.useTrash);
        return true;
    }
    return false;
  }

  private async list(rel: string) {
    try {
      const wsDirUri = this.watcherManager.wsDirUri!;
      const dirUri = this.watcherManager.toChildUri(wsDirUri, rel);

      if (rel && !this.watcherManager.watchers.has(rel)) {
        this.log.info('[ExplorerUI] registering watcher for expanded folder:', rel);
        this.watcherManager.addWatcher(rel, dirUri);
      }

      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      const items = entries
        .filter(([name, t]) => {
          const kind = t === vscode.FileType.Directory ? 'folder' : (t === vscode.FileType.File ? 'file' : 'other');
          if (kind === 'other') return false;
          return !shouldHideEntry(name, kind as 'file' | 'folder');
        })
        .map(([name, t]) => ({ name, kind: t === vscode.FileType.Directory ? 'folder' : ('file' as const) }));
      this.log.info('[ExplorerUI] list', rel, '->', items.length, 'items');
      this.post({ type: 'explorer.list.result', path: rel || '', items });
    } catch (e: any) {
      this.log.error(`list error for ${rel}: ${e?.message || String(e)}`);
      this.post({ type: 'explorer.error', op: 'list', message: e?.message || String(e) });
    }
  }

  private async open(rel: string) {
    try {
      const wsDirUri = this.watcherManager.wsDirUri!;
      const uri = this.watcherManager.toChildUri(wsDirUri, rel);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      this.log.info('[ExplorerUI] open', rel);
      this.post({ type: 'explorer.ok', op: 'open', path: rel || '' });
    } catch (e: any) {
      this.log.error(`open error for ${rel}: ${e?.message || String(e)}`);
      this.post({ type: 'explorer.error', op: 'open', message: e?.message || String(e) });
    }
  }

  private async createFile(rel: string) {
    try {
      const wsDirUri = this.watcherManager.wsDirUri!;
      const uri = this.watcherManager.toChildUri(wsDirUri, rel);
      await vscode.workspace.fs.writeFile(uri, new Uint8Array());
      this.log.info('[ExplorerUI] createFile', rel);
      this.post({ type: 'explorer.ok', op: 'createFile', path: rel || '' });
    } catch (e: any) {
      this.log.error(`createFile error for ${rel}: ${e?.message || String(e)}`);
      this.post({ type: 'explorer.error', op: 'createFile', message: e?.message || String(e) });
    }
  }

  private async createFolder(rel: string) {
    try {
      const wsDirUri = this.watcherManager.wsDirUri!;
      const uri = this.watcherManager.toChildUri(wsDirUri, rel);
      await vscode.workspace.fs.createDirectory(uri);
      this.log.info('[ExplorerUI] createFolder', rel);
      this.post({ type: 'explorer.ok', op: 'createFolder', path: rel || '' });
    } catch (e: any) {
      this.log.error(`createFolder error for ${rel}: ${e?.message || String(e)}`);
      this.post({ type: 'explorer.error', op: 'createFolder', message: e?.message || String(e) });
    }
  }

  private async remove(rel: string, recursive: boolean, useTrash: boolean) {
    try {
      const wsDirUri = this.watcherManager.wsDirUri!;
      const uri = this.watcherManager.toChildUri(wsDirUri, rel);
      await vscode.workspace.fs.delete(uri, { recursive, useTrash });
      this.log.info('[ExplorerUI] delete', rel, { recursive, useTrash });

      if (recursive) {
        this.watcherManager.removeWatcher(rel);
      }

      this.post({ type: 'explorer.ok', op: 'delete', path: rel || '' });
    } catch (e: any) {
      this.log.error(`delete error for ${rel}: ${e?.message || String(e)}`);
      this.post({ type: 'explorer.error', op: 'delete', message: e?.message || String(e) });
    }
  }

  /** 워크스페이스 루트 변경 */
  async refreshWorkspaceRoot() {
    this.watcherManager.info = undefined;
    await this.watcherManager.ensureInfo();
    this.post({ type: 'explorer.root.changed' });
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