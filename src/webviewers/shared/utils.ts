// lightweight logger factory
export function createUiLog(vscode: any, source: string) {
  return {
    debug: (t: string) => vscode.postMessage({ v: 1, type: 'ui.log', payload: { level: 'debug', text: t, source } }),
    info:  (t: string) => vscode.postMessage({ v: 1, type: 'ui.log', payload: { level: 'info',  text: t, source } }),
    warn:  (t: string) => vscode.postMessage({ v: 1, type: 'ui.log', payload: { level: 'warn',  text: t, source } }),
    error: (t: string) => vscode.postMessage({ v: 1, type: 'ui.log', payload: { level: 'error', text: t, source } }),
  };
}
