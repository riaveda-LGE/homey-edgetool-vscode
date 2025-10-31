// === src/types/vscode-webview.d.ts ===
// VS Code Webview 환경 전역 API 선언 (전역 함수 + 모듈화 표식)
declare global {
  function acquireVsCodeApi<TState = unknown>(): {
    postMessage(message: unknown): void;
    getState(): TState | undefined;
    setState(state: TState): TState;
  };
}

// 이 파일을 모듈로 인식시키기 위한 빈 export (TS가 확실히 포함하도록)
export {};
