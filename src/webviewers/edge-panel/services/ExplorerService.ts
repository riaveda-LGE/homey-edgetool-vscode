import { HostBridge } from './HostBridge.js';

export class ExplorerService {
  constructor(private host: HostBridge) {}
  list(path: string) {
    this.host.post({ v: 1, type: 'explorer.list', payload: { path } });
  }
  refresh(path: string) {
    // 수동 새로고침(Host는 list와 동일 처리)
    this.host.post({ v: 1, type: 'explorer.refresh', payload: { path } });
  }
  open(path: string) {
    this.host.post({ v: 1, type: 'explorer.open', payload: { path } });
  }
  createFile(path: string) {
    this.host.post({ v: 1, type: 'explorer.createFile', payload: { path } });
  }
  createFolder(path: string) {
    this.host.post({ v: 1, type: 'explorer.createFolder', payload: { path } });
  }
  delete(path: string, recursive = false, useTrash = true) {
    this.host.post({ v: 1, type: 'explorer.delete', payload: { path, recursive, useTrash } });
  }
}
