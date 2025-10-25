import * as fs from 'fs';
import * as path from 'path';

/** 테스트 산출물의 "고정" 루트 폴더 — 절대 바꾸지 않음 */
export const OUT_ROOT = path.resolve(__dirname, '..', 'out');

export function cleanDir(p: string) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

export function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

export function cleanAndEnsureDir(p: string) {
  cleanDir(p);
  ensureDir(p);
}

export function cleanOutputs(dir: string) {
  try {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of ents) {
      if (e.isDirectory() && /^merge_log/.test(e.name)) cleanDir(path.join(dir, e.name));
    }
  } catch {}
}

function tsForPath() {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function randSuffix(len = 5) {
  return Math.random()
    .toString(36)
    .slice(2, 2 + len);
}

export function uniqueOutSubdir(label?: string): string {
  ensureDir(OUT_ROOT);
  const safeLabel = label ? `-${label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24)}` : '';
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(OUT_ROOT, `run-${tsForPath()}-${randSuffix()}${safeLabel}`);
    try {
      fs.mkdirSync(candidate, { recursive: false });
      return candidate;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
    }
  }
  let k = 1;
  while (true) {
    const candidate = path.join(OUT_ROOT, `run-${tsForPath()}-${randSuffix()}${safeLabel}-${k++}`);
    try {
      fs.mkdirSync(candidate, { recursive: false });
      return candidate;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
    }
  }
}

export function prepareUniqueOutDir(label?: string): string {
  ensureDir(OUT_ROOT);
  return uniqueOutSubdir(label);
}
