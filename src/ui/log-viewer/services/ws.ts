// === src/ui/log-viewer/services/ws.ts ===
export type PostMsg = (type: string, payload?: any) => void;

export function createPostMessage(api: any): PostMsg {
  return (type, payload) => api?.postMessage?.({ v: 1, type, payload });
}
