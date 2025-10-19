// === src/shared/utils.ts (Extension Host 전용) ===
import * as vscode from 'vscode';

export function safeJson<T>(v: T): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 안전한 JSON 파싱 (제네릭) */
export function safeParseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** 파일을 텍스트로 읽기 */
export async function readFileAsText(uri: vscode.Uri): Promise<string> {
  const buf = await vscode.workspace.fs.readFile(uri);
  return new TextDecoder('utf8').decode(buf);
}

/** JSON 파일 읽기 (제네릭) */
export async function readJsonFile<T>(uri: vscode.Uri): Promise<T | undefined> {
  try {
    const text = await readFileAsText(uri);
    return safeParseJson<T>(text);
  } catch {
    return undefined;
  }
}

/** 경로 유틸: POSIX 스타일로 조인 */
export function posixJoin(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}

/** 경로를 POSIX 스타일로 변환 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 베이스 경로로부터 상대 경로 계산 */
export function relFromBase(baseFsPath: string, uri: vscode.Uri): string {
  const base = toPosix(baseFsPath).replace(/\/+$/, '');
  const full = toPosix(uri.fsPath);
  let rel = full.startsWith(base) ? full.slice(base.length) : full;
  rel = rel.replace(/^\/+/, '');
  return rel;
}

/** 부모 디렉토리 경로 */
export function parentDir(rel: string): string {
  const p = toPosix(rel);
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}

/** 디렉토리 존재 여부 */
export async function isDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type === vscode.FileType.Directory;
  } catch {
    return false;
  }
}

/** 파일 존재 여부 */
export async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

// ⚠️ 웹뷰 전용 로거는 이 파일에서 제거합니다. (호스트는 getLogger 사용)
// export function createUiLog(...) { ... }  ← 삭제
