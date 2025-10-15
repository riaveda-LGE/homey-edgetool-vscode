// === src/shared/types.ts ===
export type Ok<T> = { ok: true; value: T };
export type Err<E = unknown> = { ok: false; error: E };
export type Result<T, E = unknown> = Ok<T> | Err<E>;
export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

// 공통 옵션 타입들
export type TimeoutOptions = { timeoutMs?: number };
export type AbortOptions = { signal?: AbortSignal };
export type CommonOptions = TimeoutOptions & AbortOptions;

// 파일 시스템 관련
export type FileStats = {
  size: number;
  mtime: Date;
  isDirectory: boolean;
  isFile: boolean;
};

// 로그 관련
export type LogLevel = 'D' | 'I' | 'W' | 'E';

// 연결 관련
export type ConnectionType = 'ssh' | 'adb';

// UI 관련
export type TreeNode = {
  path: string;
  name: string;
  kind: 'file' | 'folder';
  parent?: TreeNode;
  children?: TreeNode[];
  expanded?: boolean;
  loaded?: boolean;
  selected?: boolean;
};