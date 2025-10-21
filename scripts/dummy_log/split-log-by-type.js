// split-log-by-type.js
// Usage examples:
//   node scripts/split-log-by-type.js --in merged.log
//   node scripts/split-log-by-type.js --in .\merged.log --out-dir ~/before_log/ --rot 3
//   node scripts/split-log-by-type.js --in merged.log --out-dir out_split --rot 5 --others others.log
//
// Help:
//   node scripts/split-log-by-type.js -h

import fs from 'fs';
import path from 'path';
import os from 'os';

// ──────────────────────────────────────────────────────────────
// CLI & help
// ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function hasFlag(...names) { return args.some((a) => names.includes(a)); }
function getArg(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return def;
}
function expandTilde(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}
function printHelp(exitCode = 0) {
  const help = `
Homey merged.log splitter (group by process type with rotation)

DESCRIPTION
  merged.log를 위에서 아래로 읽으며 프로세스명으로 타입을 식별하고,
  타입별로 모은 라인을 "회전 파일"로 나눠 저장합니다.
  - 최신 내용: <type>.log
  - 더 오래된 내용: <type>.log.1, <type>.log.2 ... (숫자가 클수록 오래됨)

USAGE
  node split-log-by-type.js --in <file> [--out-dir <dir>] [--rot <N>] [--others <file>]

OPTIONS
  --in <file>        입력 merged 로그 파일 (기본: merged.log)
  --out-dir <dir>    타입별 결과 파일 디렉터리 (기본: out_split)
  --rot <N>          타입별 회전 파일 개수 (기본: 3, 최소 1, 최대 10)
  --others <file>    매칭되지 않는 라인을 별도 파일로 저장 (옵션)
  -h, --help         도움말

TYPE MAPPING
  kernel            → kernel.log
  clip.bin          → clip.log
  cpcd              → cpcd.log
  homey-matter      → matter.log
  otbr-agent        → otbr-agent.log
  systemd, rc.local → system.log
  homey-z3gateway   → z3gateway.log
  bt_player         → bt_player.log

NOTE
  프로세스명 추출 정규식(대괄호 타임스탬프 전제):
    ^\\[[A-Z][a-z]{2}\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}\\.\\d{3,6}\\]\\s+([A-Za-z0-9._-]+)(?:\\[|:)
  - 월: 3-letter (예: Jan, Oct)
  - 일: 1~2자리
  - 밀리초: 3~6자리
`.trim();
  console.log(help);
  process.exit(exitCode);
}
if (hasFlag('-h', '--help')) printHelp(0);

const IN = expandTilde(getArg('in', 'merged.log'));
const OUT_DIR = expandTilde(getArg('out-dir', 'out_split'));
const ROT_RAW = Number(getArg('rot', 3));
const ROT = Number.isFinite(ROT_RAW) ? Math.max(1, Math.min(10, Math.trunc(ROT_RAW))) : 3;
const OTHERS = getArg('others', null) ? expandTilde(getArg('others')) : null;

// ──────────────────────────────────────────────────────────────
// Type mapping (processName → fileName base)
// ──────────────────────────────────────────────────────────────
function mapProcessToType(proc) {
  if (!proc) return null;
  if (proc === 'kernel') return { type: 'kernel', file: 'kernel.log' };
  if (proc === 'clip.bin') return { type: 'clip', file: 'clip.log' };
  if (proc === 'cpcd') return { type: 'cpcd', file: 'cpcd.log' };
  if (proc === 'homey-matter') return { type: 'matter', file: 'matter.log' };
  if (proc === 'otbr-agent') return { type: 'otbr-agent', file: 'otbr-agent.log' };
  if (proc === 'homey-z3gateway') return { type: 'z3gateway', file: 'z3gateway.log' };
  if (proc === 'bt_player') return { type: 'bt_player', file: 'bt_player.log' };
  if (proc === 'systemd' || proc === 'rc.local') return { type: 'system', file: 'system.log' };
  return null;
}

// [Mon DD HH:MM:SS.mmm] <proc>[... or : ...
const RE = /^\[[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\.\d{3,6}\]\s+([A-Za-z0-9._-]+)(?:\[|:)/;

if (!fs.existsSync(IN)) {
  console.error(`❌ input not found: ${IN}`);
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

// 모으기: 타입별 라인 배열
const perType = new Map();        // type -> string[]
const baseFileName = new Map();   // type -> 'kernel.log' 등
const unknownLines = [];

const lines = fs.readFileSync(IN, 'utf8').split(/\r?\n/);
for (const line of lines) {
  if (!line) continue; // 빈 줄 스킵
  const m = RE.exec(line);
  if (!m) { if (OTHERS) unknownLines.push(line); continue; }
  const proc = m[1];
  const map = mapProcessToType(proc);
  if (!map) { if (OTHERS) unknownLines.push(line); continue; }
  if (!perType.has(map.type)) perType.set(map.type, []);
  perType.get(map.type).push(line);
  baseFileName.set(map.type, map.file);
}

// 쓰기: 타입별 로테이션 분할
const summary = [];
for (const [type, arr] of perType.entries()) {
  const total = arr.length;
  if (total === 0) continue;

  // 실제 생성할 파트 수 (빈 파일은 만들지 않음)
  const parts = Math.min(ROT, total);

  // 균등 분할(앞쪽 파트에 1줄씩 더)
  const base = Math.floor(total / parts);
  let rem = total % parts;
  let offset = 0;

  const baseFile = baseFileName.get(type);
  const created = [];

  for (let part = 0; part < parts; part++) {
    const count = base + (part < rem ? 1 : 0);
    const seg = arr.slice(offset, offset + count);
    offset += count;

    // 최신(마지막 파트)이 .log, 그 이전은 .log.1, ... 가장 오래된(첫 파트)이 .log.(parts-1)
    const suffixIndex = parts - 1 - part;
    const fileName = suffixIndex === 0 ? baseFile : `${baseFile}.${suffixIndex}`;
    const full = path.join(OUT_DIR, fileName);
    fs.writeFileSync(full, seg.join('\n') + '\n', 'utf8');
    created.push({ file: fileName, lines: seg.length });
  }

  summary.push({ type, total, created });
}

// others (옵션)
if (OTHERS && unknownLines.length) {
  const dir = path.dirname(OTHERS);
  if (dir && dir !== '.' && dir !== '') fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OTHERS, unknownLines.join('\n') + '\n', 'utf8');
}

// 출력
console.log(`✅ split (with rotation x${ROT}) → ${path.resolve(OUT_DIR)}`);
for (const item of summary.sort((a,b)=>a.type.localeCompare(b.type))) {
  console.log(`  - ${item.type.padEnd(11)}: ${String(item.total).padStart(6)} lines`);
  for (const c of item.created) {
    console.log(`      • ${c.file.padEnd(20)} ${String(c.lines).padStart(6)}`);
  }
}
if (OTHERS) {
  const n = unknownLines.length;
  console.log(`  - others   : ${n} ${n ? `(saved to ${OTHERS})` : ''}`);
}