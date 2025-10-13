// === src/extension/panels/explorerBridge.ts ===
import * as vscode from 'vscode';
import { resolveWorkspaceInfo } from '../../core/config/userdata.js';

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

// 경로 유틸 (posix 통일)
function toPosix(p: string) {
  return p.replace(/\\/g, '/');
}
function relFromBase(baseFsPath: string, uri: vscode.Uri): string {
  const base = toPosix(baseFsPath).replace(/\/+$/, '');
  const full = toPosix(uri.fsPath);
  let rel = full.startsWith(base) ? full.slice(base.length) : full;
  rel = rel.replace(/^\/+/, '');
  return rel;
}
function parentDir(rel: string): string {
  const p = toPosix(rel);
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}

export function createExplorerBridge(
  context: vscode.ExtensionContext,
  post: (m: any) => void,
): ExplorerBridge {
  let disposed = false;
  let info: { wsDirUri: vscode.Uri } | undefined;

  // FS watcher
  let watcher: vscode.FileSystemWatcher | undefined;
  let watcherBasePath: string | undefined;

  async function ensureInfo() {
    if (!info) info = await resolveWorkspaceInfo(context);
    // 워처는 루트가 정해질 때 한 번 보장
    await ensureWatcher();
    return info!;
  }

  function toChildUri(base: vscode.Uri, rel: string) {
    const clean = String(rel || '').replace(/^[\\/]+/, '').replace(/\\/g, '/');
    const parts = clean.split('/').filter(Boolean);
    return vscode.Uri.joinPath(base, ...parts);
  }

  async function ensureWatcher() {
    if (disposed) return;
    if (!info) return;
    const baseUri = info.wsDirUri;
    const baseFsPath = baseUri.fsPath;
    if (watcher && watcherBasePath === baseFsPath) return;

    // 기존 워처 정리
    if (watcher) {
      try { watcher.dispose(); } catch {}
      watcher = undefined;
    }

    // 새 워처 생성
    const pattern = new vscode.RelativePattern(baseFsPath, '**/*');
    watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
    watcherBasePath = baseFsPath;

    const onFs = (uri: vscode.Uri) => {
      if (disposed) return;
      try {
        const rel = relFromBase(baseFsPath, uri);
        // 상위 폴더 기준으로만 UI 갱신 유도
        const dir = parentDir(rel);
        // 숨김 루트(예: .git 폴더 내부 변화)는 무시 (상위 첫 세그먼트 기준)
        const top = dir.split('/').filter(Boolean)[0] ?? rel.split('/').filter(Boolean)[0] ?? '';
        if (HIDE_DIRS.has(top)) return;

        console.log('[explorerBridge] fs event:', uri.fsPath, 'rel:', rel, 'dir:', dir);

        // UI에 변경 알림
        post({ type: 'explorer.fs.changed', path: rel });
      } catch (e) {
        console.error('[explorerBridge] fs event error', e);
      }
    };

    const d1 = watcher.onDidCreate(onFs);
    const d2 = watcher.onDidChange(onFs);
    const d3 = watcher.onDidDelete(onFs);

    context.subscriptions.push(watcher, d1, d2, d3);

    console.log('[explorerBridge] watcher ready at', toPosix(baseFsPath));
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
      console.log('[explorerBridge] list', rel, '->', items.length, 'items');
      post({ type: 'explorer.list.result', path: rel || '', items });
    } catch (e: any) {
      console.error('[explorerBridge] list error', rel, e);
      post({ type: 'explorer.error', op: 'list', message: e?.message || String(e) });
    }
  }

  async function open(rel: string) {
    try {
      const { wsDirUri } = await ensureInfo();
      const uri = toChildUri(wsDirUri, rel);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      console.log('[explorerBridge] open', rel);
      post({ type: 'explorer.ok', op: 'open', path: rel || '' });
    } catch (e: any) {
      console.error('[explorerBridge] open error', rel, e);
      post({ type: 'explorer.error', op: 'open', message: e?.message || String(e) });
    }
  }

  async function createFile(rel: string) {
    try {
      const { wsDirUri } = await ensureInfo();
      const uri = toChildUri(wsDirUri, rel);
      await vscode.workspace.fs.writeFile(uri, new Uint8Array());
      console.log('[explorerBridge] createFile', rel);
      post({ type: 'explorer.ok', op: 'createFile', path: rel || '' });
    } catch (e: any) {
      console.error('[explorerBridge] createFile error', rel, e);
      post({ type: 'explorer.error', op: 'createFile', message: e?.message || String(e) });
    }
  }

  async function createFolder(rel: string) {
    try {
      const { wsDirUri } = await ensureInfo();
      const uri = toChildUri(wsDirUri, rel);
      await vscode.workspace.fs.createDirectory(uri);
      console.log('[explorerBridge] createFolder', rel);
      post({ type: 'explorer.ok', op: 'createFolder', path: rel || '' });
    } catch (e: any) {
      console.error('[explorerBridge] createFolder error', rel, e);
      post({ type: 'explorer.error', op: 'createFolder', message: e?.message || String(e) });
    }
  }

  async function remove(rel: string, recursive: boolean, useTrash: boolean) {
    try {
      const { wsDirUri } = await ensureInfo();
      const uri = toChildUri(wsDirUri, rel);
      await vscode.workspace.fs.delete(uri, { recursive, useTrash });
      console.log('[explorerBridge] delete', rel, { recursive, useTrash });
      
      // 삭제 성공 후 UI 갱신 강제 트리거 (와쳐가 놓칠 수 있는 경우 대비)
      const parentPath = parentDir(rel);
      post({ type: 'explorer.fs.changed', path: rel }); // 삭제된 항목
      if (parentPath !== rel) { // 부모 폴더도 갱신
        post({ type: 'explorer.fs.changed', path: parentPath + '/dummy' });
      }
      
      post({ type: 'explorer.ok', op: 'delete', path: rel || '' });
    } catch (e: any) {
      console.error('[explorerBridge] delete error', rel, e);
      post({ type: 'explorer.error', op: 'delete', message: e?.message || String(e) });
    }
  }

  async function refreshWorkspaceRoot() {
    // 다음 ensureInfo에서 새 루트를 읽도록 초기화
    info = undefined;
    // 기존 워처 제거
    if (watcher) {
      try { watcher.dispose(); } catch {}
      watcher = undefined;
      watcherBasePath = undefined;
    }
    // 새 루트 정보 불러오고 워처 재바인딩
    await ensureInfo();
    // UI에 루트 변경 통지 → UI는 상태 초기화 후 루트 목록 다시 요청
    post({ type: 'explorer.root.changed', path: '' });
  }

  return {
    async handleMessage(msg: any) {
      if (disposed || !msg) return false;
      switch (msg.type) {
        case 'explorer.list':
          console.log('[explorerBridge] <- list', msg.path);
          await list(String(msg.path || ''));
          return true;
        case 'explorer.open':
          console.log('[explorerBridge] <- open', msg.path);
          await open(String(msg.path || ''));
          return true;
        case 'explorer.createFile':
          console.log('[explorerBridge] <- createFile', msg.path);
          await createFile(String(msg.path || ''));
          return true;
        case 'explorer.createFolder':
          console.log('[explorerBridge] <- createFolder', msg.path);
          await createFolder(String(msg.path || ''));
          return true;
        case 'explorer.delete':
          console.log('[explorerBridge] <- delete', msg.path, { recursive: !!msg.recursive, useTrash: !!msg.useTrash });
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
      if (watcher) {
        try { watcher.dispose(); } catch (e) { console.error('[explorerBridge] watcher dispose error', e); }
        watcher = undefined;
        watcherBasePath = undefined;
      }
    },
  };
}