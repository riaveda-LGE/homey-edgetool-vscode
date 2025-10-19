// src/shared/env.ts
/**
 * 공용 모드 헬퍼 (Extension Host(Node) + Webview 공통)
 * - deploy.js에서 EXT_MODE=esd 주입
 * - webpack.DefinePlugin으로 __ESD__, process.env.NODE_ENV, process.env.EXT_MODE 주입
 */

declare const __ESD__: boolean | undefined;

export const IS_WEBVIEW = typeof window !== 'undefined' && typeof document !== 'undefined';

export const IS_EXTENSION_HOST =
  typeof process !== 'undefined' && !!(process as any).versions?.node && !IS_WEBVIEW;

// Webpack DefinePlugin에서 온 플래그(웹뷰에서 우선 사용)
const fromDefine = typeof __ESD__ !== 'undefined' ? Boolean(__ESD__) : undefined;

// Node(익스텐션) 측 환경변수
const fromEnv =
  typeof process !== 'undefined' && (process as any).env
    ? (process as any).env.EXT_MODE === 'esd' || (process as any).env.NODE_ENV === 'development'
    : undefined;

/** 개발(ESD/EDH) 모드인지 여부 */
export const IS_ESD: boolean = fromDefine ?? fromEnv ?? false;

/** 배포(Prod) 모드인지 여부 */
export const IS_PROD: boolean = !IS_ESD;

/** 모드 태그 */
export function modeTag(): 'esd' | 'prod' {
  return IS_ESD ? 'esd' : 'prod';
}

/** 개발 모드에서만 실행 */
export function runInESD(fn: () => void) {
  if (IS_ESD) fn();
}
