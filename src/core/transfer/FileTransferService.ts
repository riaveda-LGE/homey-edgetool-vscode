// === src/core/transfer/FileTransferService.ts ===
import { getLogger } from '../logging/extension-logger.js';

export class FileTransferService {
  private log = getLogger('FileTransfer');
  async uploadViaTarBase64(local: string, remote: string, opts?: { timeoutMs?: number; signal?: AbortSignal }) {
    this.log.info(`[stub] uploadViaTarBase64 local=${local} -> remote=${remote}`);
    // TODO: 실제 tar/base64 파이프 구현 연결
  }
  async downloadViaTarBase64(remote: string, local: string, opts?: { timeoutMs?: number; signal?: AbortSignal }) {
    this.log.info(`[stub] downloadViaTarBase64 remote=${remote} -> local=${local}`);
  }
}
