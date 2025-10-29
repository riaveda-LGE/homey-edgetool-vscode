//src/types/ssh2.d.ts
declare module 'ssh2' {
  import { EventEmitter } from 'events';
  export class Client extends EventEmitter {
    connect(config: {
      host: string;
      port?: number;
      username?: string;
      password?: string;
      privateKey?: Buffer | string;
      readyTimeout?: number;
      keepaliveInterval?: number;
      tryKeyboard?: boolean;
    }): this;
    end(): this;
    exec(command: string, callback: (err: Error | undefined, stream: any) => void): void;
  }
}
