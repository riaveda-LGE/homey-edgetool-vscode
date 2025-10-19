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

export function iso(i: number) {
  // 기준: 2025-01-01T00:00:00.000Z + i*1000ms
  const d = new Date(1735689600000 + i * 1000);
  return d.toISOString();
}

/** 지정 스펙대로 ISO 타임스탬프 로그 파일들을 생성 */
export async function writeIsoLogs(
  dir: string,
  spec: Record<string, number>, // { type: lineCount }
): Promise<void> {
  ensureDir(dir);
  await Promise.all(
    Object.entries(spec).map(
      ([type, n]) =>
        new Promise<void>((resolve, reject) => {
          const file = path.join(dir, `${type}.log`);
          const ws = fs.createWriteStream(file, { encoding: 'utf8' });
          ws.on('error', reject);
          ws.on('finish', resolve);
          for (let i = 0; i < n; i++) {
            ws.write(`${iso(i)} ${type} message ${i}\n`);
          }
          ws.end();
        }),
    ),
  );
}

/** 임시 입력 디렉터리를 초기화하고 spec에 맞춰 로그들을 생성한 뒤 그 경로를 반환 */
export async function setupTempInput(dir: string, spec: Record<string, number>): Promise<string> {
  cleanAndEnsureDir(dir);
  await writeIsoLogs(dir, spec);
  return dir;
}

/** 이전 병합 산출물(merge_log*) 폴더 제거 */
export function cleanOutputs(dir: string) {
  try {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of ents) {
      if (e.isDirectory() && /^merge_log/.test(e.name)) {
        cleanDir(path.join(dir, e.name));
      }
    }
  } catch {}
}

/** 즉시 예약/타이머 큐를 한 번씩 비워 늦은 로그/flush 소진 */
export async function drainNextTicks() {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setTimeout(r, 0));
}

/** 파일시스템 안전한 타임스탬프(경로명용) */
function tsForPath() {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** 간단 랜덤 suffix */
function randSuffix(len = 5) {
  return Math.random()
    .toString(36)
    .slice(2, 2 + len);
}

/** out/ 내부에 항상 고유한 하위 경로를 생성해 반환 (ex: out/run-20250101-101530-123-A1b2c[-label]) */
export function uniqueOutSubdir(label?: string): string {
  ensureDir(OUT_ROOT);
  const safeLabel = label ? `-${label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24)}` : '';
  // 충돌 가능성 아주 낮지만, 혹시 모를 EEXIST 대비로 몇 번 재시도
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(OUT_ROOT, `run-${tsForPath()}-${randSuffix()}${safeLabel}`);
    try {
      fs.mkdirSync(candidate, { recursive: false });
      return candidate;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
    }
  }
  // 극히 드문 경우: 마지막에 카운터를 붙여 보장
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

/** 고정 out/ 아래에 유니크 하위 폴더를 만들어 반환 */
export function prepareUniqueOutDir(label?: string): string {
  ensureDir(OUT_ROOT);
  return uniqueOutSubdir(label);
}
