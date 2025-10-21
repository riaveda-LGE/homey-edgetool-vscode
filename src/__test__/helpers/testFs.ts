import * as fs from 'fs';
import * as path from 'path';

/** 테스트 산출물의 "고정" 루트 폴더 — 절대 바꾸지 않음 */
export const OUT_ROOT = path.resolve(__dirname, '..', 'out');

export function cleanDir(p: string) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

export function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

export function cleanAndEnsureDir(p: string) {
  cleanDir(p);
  ensureDir(p);
}

export function iso(i: number) {
  const d = new Date(1735689600000 + i * 1000);
  return d.toISOString();
}

export async function writeIsoLogs(dir: string, spec: Record<string, number>): Promise<void> {
  ensureDir(dir);
  await Promise.all(
    Object.entries(spec).map(
      ([type, n]) =>
        new Promise<void>((resolve, reject) => {
          const file = path.join(dir, `${type}.log`);
          const ws = fs.createWriteStream(file, { encoding: 'utf8' });
          ws.on('error', reject);
          ws.on('finish', resolve);
          for (let i = 0; i < n; i++) ws.write(`${iso(i)} ${type} message ${i}\n`);
          ws.end();
        }),
    ),
  );
}

export async function setupTempInput(dir: string, spec: Record<string, number>): Promise<string> {
  cleanAndEnsureDir(dir);
  await writeIsoLogs(dir, spec);
  return dir;
}

export function cleanOutputs(dir: string) {
  try {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of ents) {
      if (e.isDirectory() && /^merge_log/.test(e.name)) cleanDir(path.join(dir, e.name));
    }
  } catch {}
}

export async function drainNextTicks() {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setTimeout(r, 0));
}

function tsForPath() {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function randSuffix(len = 5) {
  return Math.random().toString(36).slice(2, 2 + len);
}

export function uniqueOutSubdir(label?: string): string {
  ensureDir(OUT_ROOT);
  const safeLabel = label ? `-${label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24)}` : '';
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(OUT_ROOT, `run-${tsForPath()}-${randSuffix()}${safeLabel}`);
    try { fs.mkdirSync(candidate, { recursive: false }); return candidate; }
    catch (e: any) { if (e?.code !== 'EEXIST') throw e; }
  }
  let k = 1;
  while (true) {
    const candidate = path.join(OUT_ROOT, `run-${tsForPath()}-${randSuffix()}${safeLabel}-${k++}`);
    try { fs.mkdirSync(candidate, { recursive: false }); return candidate; }
    catch (e: any) { if (e?.code !== 'EEXIST') throw e; }
  }
}

export function prepareUniqueOutDir(label?: string): string {
  ensureDir(OUT_ROOT);
  return uniqueOutSubdir(label);
}