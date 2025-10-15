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

export function createExplorerBridge(
  context: vscode.ExtensionContext,
  post: (m: any) => void,
): ExplorerBridge {
  const log = getLogger('extension:panels:explorerBridge');
  let disposed = false;
  let info: { wsDirUri: vscode.Uri } | undefined;

  // 동적 워처 맵: 폴더 경로 -> 워처
  const watchers = new Map<string, vscode.FileSystemWatcher>();

  async function ensureInfo() {
    if (!info) {
      info = await resolveWorkspaceInfo(context);
      // 워처는 루트가 정해질 때 한 번 보장
      await ensureWatchers();
    }
    return info!;
  }

  function toChildUri(base: vscode.Uri, rel: string) {
    const clean = String(rel || '').replace(/^[\\/]+/, '').replace(/\\/g, '/');
    const parts = clean.split('/').filter(Boolean);
    return vscode.Uri.joinPath(base, ...parts);
  }

  function addWatcherForFolder(relPath: string, folderUri: vscode.Uri) {
    if (disposed || watchers.has(relPath)) {
      log.info('watcher already exists or disposed for folder:', relPath);
      return;
    }

    const pattern = new vscode.RelativePattern(folderUri.fsPath, '**/*');
    const w = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
    watchers.set(relPath, w);

    log.info('adding watcher for folder:', relPath, 'at path:', folderUri.fsPath);

    const onFs = (uri: vscode.Uri) => {
      if (disposed) return;
      try {
        const baseFsPath = info!.wsDirUri.fsPath;
        const rel = relFromBase(baseFsPath, uri);
        const dir = parentDir(rel);
        const top = dir.split('/').filter(Boolean)[0] ?? rel.split('/').filter(Boolean)[0] ?? '';
        if (HIDE_DIRS.has(top)) return;

        log.info('[explorerBridge] fs event in folder', relPath, ':', uri.fsPath, 'rel:', rel);

        // 폴더 생성 시 워처 추가
        if (uri.fsPath.startsWith(folderUri.fsPath)) {
          (vscode.workspace.fs.stat(uri) as Promise<any>).then((stat) => {
            if (stat.type === vscode.FileType.Directory) {
              const newRel = relFromBase(baseFsPath, uri);
              log.info('[explorerBridge] detected folder creation:', newRel, 'adding watcher');
              addWatcherForFolder(newRel, uri);
            }
          }).catch(() => {});
        }

        // 폴더 삭제 시 워처 해제
        // onDidDelete에서 처리

        // UI에 변경 알림
        post({ type: 'explorer.fs.changed', path: rel });
      } catch (e) {
        log.error('[explorerBridge] fs event error', e);
      }
    };

    const onDelete = (uri: vscode.Uri) => {
      if (disposed) return;
      try {
        const baseFsPath = info!.wsDirUri.fsPath;
        const rel = relFromBase(baseFsPath, uri);

        // 삭제 이벤트가 발생했으므로 watcher가 있다면 무조건 제거
        removeWatcherForFolder(rel);

        // 파일 존재 여부 확인 (폴더 타입 확인용)
        Promise.resolve(vscode.workspace.fs.stat(uri)).then((stat: vscode.FileStat) => {
          if (stat.type === vscode.FileType.Directory) {
            log.info('[explorerBridge] confirmed folder deletion:', rel);
          } else {
            log.debug('[explorerBridge] file deletion detected:', rel);
          }
        }).catch(() => {});

        post({ type: 'explorer.fs.changed', path: rel });
      } catch (e) {
        log.error('[explorerBridge] delete event error', e);
      }
    };

    const d1 = w.onDidCreate(onFs);
    const d2 = w.onDidChange(onFs);
    const d3 = w.onDidDelete(onDelete);

    context.subscriptions.push(w, d1, d2, d3);

    log.info('[explorerBridge] watcher added for folder:', relPath);
  }

  function removeWatcherForFolder(relPath: string) {
    const w = watchers.get(relPath);
    if (w) {
      log.info('[explorerBridge] removing watcher for folder:', relPath);
      try { w.dispose(); } catch (e) { log.error('[explorerBridge] watcher dispose error for', relPath, e); }
      watchers.delete(relPath);
      log.info('[explorerBridge] watcher removed for folder:', relPath);
    } else {
      log.info('[explorerBridge] no watcher found to remove for folder:', relPath);
    }
  }

  async function ensureWatchers() {
    if (disposed || !info) return;
    const baseUri = info.wsDirUri;
    const baseFsPath = baseUri.fsPath;

    // 기존 워처 모두 해제
    for (const [path, w] of watchers) {
      try { w.dispose(); } catch {}
    }
    watchers.clear();

    // 루트 폴더 스캔해서 기존 폴더에 워처 등록
    try {
      const entries = await vscode.workspace.fs.readDirectory(baseUri);
      for (const [name, type] of entries) {
        if (type === vscode.FileType.Directory && !shouldHideEntry(name, 'folder')) {
          const folderRel = name;
          const folderUri = vscode.Uri.joinPath(baseUri, name);
          log.info('[explorerBridge] initializing watcher for existing folder:', folderRel);
          addWatcherForFolder(folderRel, folderUri);
        }
      }
    } catch (e) {
      log.error('[explorerBridge] initial folder scan error', e);
    }

    log.info('[explorerBridge] watchers initialized for workspace root:', toPosix(baseFsPath));
  }

  async function list(rel: string) {
    try {
      const { wsDirUri } = await ensureInfo();
      const dirUri = toChildUri(wsDirUri, rel);
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      const items = entries
        .filter(([name, t]) => {
          const kind = t === vscode.FileType.Directory ? 'folder' : (t === vscode.FileType.File ? 'file' : 'other');
          if (kind === 'other') return false;
          return !shouldHideEntry(name, kind as 'file' | 'folder');
        })
        .map(([name, t]) => ({ name, kind: t === vscode.FileType.Directory ? 'folder' : ('file' as const) }));
      log.info('[explorerBridge] list', rel, '->', items.length, 'items');
      post({ type: 'explorer.list.result', path: rel || '', items });
    } catch (e: any) {
      log.error(`list error for ${rel}: ${e?.message || String(e)}`);
      post({ type: 'explorer.error', op: 'list', message: e?.message || String(e) });
    }
  }

  async function open(rel: string) {
    try {
      const { wsDirUri } = await ensureInfo();
      const uri = toChildUri(wsDirUri, rel);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      log.info('[explorerBridge] open', rel);
      post({ type: 'explorer.ok', op: 'open', path: rel || '' });
    } catch (e: any) {
      log.error(`open error for ${rel}: ${e?.message || String(e)}`);
      post({ type: 'explorer.error', op: 'open', message: e?.message || String(e) });
    }
  }

  async function createFile(rel: string) {
    try {
      const { wsDirUri } = await ensureInfo();
      const uri = toChildUri(wsDirUri, rel);
      await vscode.workspace.fs.writeFile(uri, new Uint8Array());
      log.info('[explorerBridge] createFile', rel);
      post({ type: 'explorer.ok', op: 'createFile', path: rel || '' });
    } catch (e: any) {
      log.error(`createFile error for ${rel}: ${e?.message || String(e)}`);
      post({ type: 'explorer.error', op: 'createFile', message: e?.message || String(e) });
    }
  }

  async function createFolder(rel: string) {
    try {
      const { wsDirUri } = await ensureInfo();
      const uri = toChildUri(wsDirUri, rel);
      await vscode.workspace.fs.createDirectory(uri);
      log.info('[explorerBridge] createFolder', rel);
      post({ type: 'explorer.ok', op: 'createFolder', path: rel || '' });
    } catch (e: any) {
      log.error(`createFolder error for ${rel}: ${e?.message || String(e)}`);
      post({ type: 'explorer.error', op: 'createFolder', message: e?.message || String(e) });
    }
  }

  async function remove(rel: string, recursive: boolean, useTrash: boolean) {
    try {
      const { wsDirUri } = await ensureInfo();
      const uri = toChildUri(wsDirUri, rel);
      await vscode.workspace.fs.delete(uri, { recursive, useTrash });
      log.info('[explorerBridge] delete', rel, { recursive, useTrash });

      // 폴더 삭제 시 워처 제거 (onDelete 이벤트 방지)
      if (recursive) {
        removeWatcherForFolder(rel);
      }

      post({ type: 'explorer.ok', op: 'delete', path: rel || '' });
    } catch (e: any) {
      log.error(`delete error for ${rel}: ${e?.message || String(e)}`);
      post({ type: 'explorer.error', op: 'delete', message: e?.message || String(e) });
    }
  }

  async function refreshWorkspaceRoot() {
    // 다음 ensureInfo에서 새 루트를 읽도록 초기화
    info = undefined;
    // 기존 워처 모두 해제
    for (const [path, w] of watchers) {
      log.info('[explorerBridge] disposing watcher for folder:', path, 'due to root change');
      try { w.dispose(); } catch {}
    }
    watchers.clear();
    log.info('[explorerBridge] all watchers disposed for workspace root change');
    // 새 루트 정보 불러오고 워처 재바인딩
    await ensureInfo();
    // UI에 루트 변경 통지 → UI는 상태 초기화 후 루트 목록 다시 요청
    post({ type: 'explorer.root.changed' });
  }

  return {
    async handleMessage(msg: any) {
      if (disposed || !msg) return false;
      switch (msg.type) {
        case 'explorer.list':
          log.info('[explorerBridge] <- list', msg.path);
          await list(String(msg.path || ''));
          return true;
        case 'explorer.open':
          log.info('[explorerBridge] <- open', msg.path);
          await open(String(msg.path || ''));
          return true;
        case 'explorer.createFile':
          log.info('[explorerBridge] <- createFile', msg.path);
          await createFile(String(msg.path || ''));
          return true;
        case 'explorer.createFolder':
          log.info('[explorerBridge] <- createFolder', msg.path);
          await createFolder(String(msg.path || ''));
          return true;
        case 'explorer.delete':
          log.info('[explorerBridge] <- delete', msg.path, { recursive: !!msg.recursive, useTrash: !!msg.useTrash });
          await remove(String(msg.path || ''), !!msg.recursive, !!msg.useTrash);
          return true;
      }
      return false;
    },
    async refreshWorkspaceRoot() {
      await refreshWorkspaceRoot();
    },
    dispose() {
      disposed = true;
      for (const [path, w] of watchers) {
        log.info('[explorerBridge] disposing watcher for folder:', path, 'on bridge dispose');
        try { w.dispose(); } catch (e) { log.error('[explorerBridge] watcher dispose error', e); }
      }
      watchers.clear();
      log.info('[explorerBridge] all watchers disposed on bridge dispose');
    },
  };
}