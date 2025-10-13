// === src/extension/ui/input.ts ===
import * as vscode from 'vscode';

type InputOpts = Omit<vscode.InputBoxOptions, 'ignoreFocusOut'> & { ignoreFocusOut?: boolean };
type PickItem = string | vscode.QuickPickItem;

const DEFAULT_IFO = true; // ignoreFocusOut 기본값

/** 텍스트 입력 */
export async function promptText(opts: InputOpts): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    ignoreFocusOut: opts.ignoreFocusOut ?? DEFAULT_IFO,
    ...opts,
  });
  return value?.trim();
}

/** 비밀번호 입력 */
export async function promptSecret(opts: InputOpts): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    ignoreFocusOut: opts.ignoreFocusOut ?? DEFAULT_IFO,
    password: true,
    ...opts,
  });
  return value;
}

/** 숫자 입력 */
export async function promptNumber(
  opts: InputOpts & { min?: number; max?: number },
): Promise<number | undefined> {
  const raw = await vscode.window.showInputBox({
    ignoreFocusOut: opts.ignoreFocusOut ?? DEFAULT_IFO,
    validateInput: (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return '숫자를 입력하세요';
      if (opts.min !== undefined && n < opts.min) return `최소 ${opts.min}`;
      if (opts.max !== undefined && n > opts.max) return `최대 ${opts.max}`;
      return opts.validateInput?.(v);
    },
    ...opts,
  });
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** QuickPick (단일 선택) */
export async function pickOne(
  items: PickItem[],
  opts: vscode.QuickPickOptions = {},
): Promise<vscode.QuickPickItem | undefined> {
  const norm = items.map((i) => (typeof i === 'string' ? { label: i } : i));
  return vscode.window.showQuickPick(norm, {
    ignoreFocusOut: (opts as any)?.ignoreFocusOut ?? DEFAULT_IFO,
    canPickMany: false,
    ...opts,
  });
}

/** 폴더 선택 */
export async function pickFolder(
  opts: {
    title?: string;
    defaultUri?: vscode.Uri;
    openLabel?: string;
  } = {},
): Promise<vscode.Uri | undefined> {
  const sel = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: opts.title ?? '폴더 선택',
    defaultUri: opts.defaultUri,
    openLabel: opts.openLabel ?? 'Select folder',
  });
  return sel?.[0];
}

/** 파일 선택 */
export async function pickFile(
  opts: {
    title?: string;
    defaultUri?: vscode.Uri;
    filters?: { [name: string]: string[] };
    openLabel?: string;
  } = {},
): Promise<vscode.Uri | undefined> {
  const sel = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    title: opts.title ?? '파일 선택',
    defaultUri: opts.defaultUri,
    filters: opts.filters,
    openLabel: opts.openLabel ?? 'Select file',
  });
  return sel?.[0];
}

/** 확인/취소 */
export async function confirm(message: string, detail?: string): Promise<boolean> {
  const r = await vscode.window.showInformationMessage(
    message,
    { modal: false, detail },
    '확인',
    '취소',
  );
  return r === '확인';
}

/* =========================
 * QuickInput Wizard (멀티스텝)
 * ========================= */
export async function multiStep<T>(
  steps: Array<(state: T) => Promise<void | symbol>>,
  state: T,
): Promise<T> {
  const SKIP = Symbol('skip');
  for (const step of steps) {
    const res = await step(state);
    if (res === SKIP) continue;
  }
  return state;
}
