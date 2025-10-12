// === src/extension/panels/explorerBridge.ts ===
import * as vscode from 'vscode';
import { resolveWorkspaceInfo } from '../../core/config/userdata.js';

export type ExplorerBridge = {
  handleMessage(msg: any): Promise<boolean>;
  dispose(): void;
};

export function createExplorerBridge(
  context: vscode.ExtensionContext,
  post: (m: any) => void,
): ExplorerBridge {
  let disposed = false;
  let info: { wsDirUri: vscode.Uri } | undefined;

  async function ensureInfo() {
    if (!info) info = await resolveWorkspaceInfo(context);
    return info!;
  }

  function toChildUri(base: vscode.Uri, rel: string) {
    const clean = String(rel || '').replace(/^[\\/]+/, '').replace(/\\/g, '/');
    const parts = clean.split('/').filter(Boolean);
    return vscode.Uri.joinPath(base, ...parts);
  }

  async function list(rel: string) {
    try {
      const { wsDirUri } = await ensureInfo();
      const dirUri = toChildUri(wsDirUri, rel);
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      const items = entries
        .filter(([_, t]) => t === vscode.FileType.File || t === vscode.FileType.Directory)
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
      post({ type: 'explorer.ok', op: 'delete', path: rel || '' });
    } catch (e: any) {
      console.error('[explorerBridge] delete error', rel, e);
      post({ type: 'explorer.error', op: 'delete', message: e?.message || String(e) });
    }
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
    dispose() { disposed = true; },
  };
}
