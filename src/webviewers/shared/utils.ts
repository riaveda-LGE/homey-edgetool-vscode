// === webview 전용 유틸 ===
export type UiLogger = {
  debug: (t: unknown) => void;
  info: (t: unknown) => void;
  warn: (t: unknown) => void;
  error: (t: unknown) => void;
};

// 안전 문자열화
function toStr(t: unknown): string {
  console.debug?.('[debug] toStr: start');
  if (typeof t === 'string') return t;
  try {
    return JSON.stringify(t);
  } catch {
    return String(t);
  }
  console.debug?.('[debug] toStr: end');
}

// lightweight UI logger: webview → extension host 로 전달
export function createUiLog(vscodeApi: any, source: string): UiLogger {
  console.debug?.(`[debug] createUiLog: start for ${source}`);
  const post = (level: 'debug' | 'info' | 'warn' | 'error', t: unknown) => {
    const text = toStr(t);
    try {
      vscodeApi?.postMessage?.({ v: 1, type: 'ui.log', payload: { level, text, source } });
    } catch (e) {
      // 폴백: 웹뷰 콘솔에도 찍어준다
      const tag = `[ui.log:${source}]`;
      if (level === 'error') console.error?.(tag, text);
      else if (level === 'warn') console.warn?.(tag, text);
      else if (level === 'info') console.info?.(tag, text);
      else console.debug?.(tag, text);
    }
  };
  console.debug?.(`[debug] createUiLog: end for ${source}`);
  return {
    debug: (t) => post('debug', t),
    info: (t) => post('info', t),
    warn: (t) => post('warn', t),
    error: (t) => post('error', t),
  };
}
