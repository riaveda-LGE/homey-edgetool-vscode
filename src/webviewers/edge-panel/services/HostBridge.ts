import type { H2W,W2H } from '@ipc/messages';

export class HostBridge {
  constructor(private vscode: any) {}

  post<T extends W2H>(msg: T) {
    this.vscode.postMessage(msg);
  }

  listen(handler: (msg: H2W) => void) {
    window.addEventListener('message', (event) => {
      handler((event as MessageEvent<any>).data as H2W);
    });
  }
}
