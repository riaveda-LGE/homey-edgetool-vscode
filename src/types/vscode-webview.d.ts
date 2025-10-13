// === src/types/vscode-webview.d.ts ===
// VS Code Webview 환경 전역 API 선언 (한 번만 선언)
declare function acquireVsCodeApi(): {
  postMessage: (message: any) => void;
  getState?: () => any;
  setState?: (state: any) => void;
};
