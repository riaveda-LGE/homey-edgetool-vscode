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
  let out: string;
  if (typeof t === 'string') {
    out = t;
  } else {
    try {
      out = JSON.stringify(t);
    } catch {
      out = String(t);
    }
  }
  console.debug?.('[debug] toStr: end');
  return out;
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

/** Webview 전용 성능 계측 래퍼 팩토리 (Host로 perfMeasure 전송) */
export function createUiMeasure(
  vscodeApi: any,
  opts?: { enabled?: boolean; minMs?: number; sampleEvery?: number; source?: string },
) {
  // 기본값을 false로 낮춰 Host 쪽 'unknown webview message: perfMeasure' 경고 소거
  // (필요 시 호출부에서 enabled:true로 켜서 사용)
  let enabled = opts?.enabled ?? false;
  const minMs = Math.max(0, opts?.minMs ?? 0);
  const sampleEvery = Math.max(1, opts?.sampleEvery ?? 1);
  const source = opts?.source ?? 'ui';
  let counter = 0;
  return function measureUi<T>(name: string, fn: () => T): T {
    const t0 = globalThis.performance.now();
    const result = fn();
    const dt = globalThis.performance.now() - t0;
    if (enabled && dt >= minMs) {
      counter++;
      if ((counter % sampleEvery) === 0) {
        try {
          vscodeApi?.postMessage?.({ v: 1, type: 'perfMeasure', payload: { name, duration: dt, source } });
        } catch {
          // no-op
        }
      }
    }
    return result;
  };
}

/** (선택) 객체의 메서드를 모두 UI 계측 래퍼로 감싸기 */
export function wrapAllUiMethods<T extends object>(obj: T, measureUi: (name: string, fn: Function) => any, prefix?: string): T {
  const tag = prefix || (obj as any)?.constructor?.name || 'Object';
  return new Proxy(obj, {
    get(target, p, receiver) {
      const v = Reflect.get(target, p, receiver);
      if (typeof v === 'function' && p !== 'constructor') {
        const name = `${tag}.${String(p)}`;
        return (...args: any[]) => measureUi(name, () => v.apply(target, args));
      }
      return v;
    },
  });
}
