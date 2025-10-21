// generate-homey-merged.js
// Usage examples:
//   node scripts/generate-homey-merged.js --total 3000 ./after_merge/
//   node scripts/generate-homey-merged.js --total 3000 ./after_merge/merged.log
//   node scripts/generate-homey-merged.js --total 8000 --out ~/logs/merged.log --base 2025-10-20 --days 2 --seed 1
//
// Help:
//   node scripts/generate-homey-merged.js -h

import fs from 'fs';
import path from 'path';
import os from 'os';

// ──────────────────────────────────────────────────────────────
// CLI args & help
// ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function hasFlag(...names) {
  return args.some((a) => names.includes(a));
}
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
Homey dummy merged log generator

DESCRIPTION
  8가지 타입(kernel, clip, cpcd, matter, otbr-agent, system, z3gateway, bt_player)을
  2일(기본) 범위에 균등 분포로 합쳐 시간 오름차순 merged.log를 생성합니다.

USAGE
  node generate-homey-merged.js --total <N> [--out <file>] [--base YYYY-MM-DD] [--days D] [--seed S] [<OUT_PATH>]

OUTPUT PATH RULES
  - --out <file> 를 쓰거나,
  - 마지막 위치 인자 <OUT_PATH> 를 줄 수 있습니다.
    • <폴더 경로>/  → 그 폴더 안에 merged.log 생성 (폴더 없으면 생성)
    • <파일 경로>   → 해당 파일에 생성
  - ~ 는 홈 디렉터리로 확장됩니다.

OPTIONS
  --total <N>         최종 로그 라인 수 (필수)
  --out <file>        출력 파일 경로 (선택)
  --base <YYYY-MM-DD> 시작 날짜(자정) (기본: 2025-10-20)
  --days <D>          base로부터 일수 범위 (기본: 2)
  --seed <S>          랜덤 시드 (선택, 재현성)
  -h, --help          도움말

EXAMPLES
  node generate-homey-merged.js --total 3000 ./after_merge/
  node generate-homey-merged.js --total 3000 ./after_merge/merged.log
  node generate-homey-merged.js --total 8000 --out ~/logs/merged.log --seed 1
`.trim();
  console.log(help);
  process.exit(exitCode);
}
if (hasFlag('-h', '--help')) printHelp(0);

const KNOWN = new Set(['--total','--out','--base','--days','--seed','-h','--help']);
const TOTAL = Number(getArg('total', NaN));
if (!Number.isFinite(TOTAL) || TOTAL <= 0) {
  console.error('❌ --total <N> 을(를) 지정하세요. 예) --total 3000');
  printHelp(1);
}
const BASE = getArg('base', '2025-10-20');
const DAYS = Number(getArg('days', 2));
const SEED = getArg('seed', null);

// 위치 인자에서 출력 경로 감지(마지막 토큰 1개 허용)
const positionals = args.filter((a, i) => {
  if (a.startsWith('--')) return false;
  const prev = args[i-1];
  if (prev && prev.startsWith('--') && KNOWN.has(prev)) return false; // flag value
  return !KNOWN.has(a);
});

let OUT = getArg('out', 'merged.log');
let OUT_EXPANDED = expandTilde(OUT);

if (positionals.length > 0) {
  const raw = expandTilde(positionals[positionals.length - 1]);
  const endsWithSep = /[\\\/]$/.test(raw);
  const isExistingDir = (() => {
    try { return fs.existsSync(raw) && fs.statSync(raw).isDirectory(); } catch { return false; }
  })();
  if (endsWithSep || isExistingDir) {
    fs.mkdirSync(raw, { recursive: true });
    OUT_EXPANDED = path.join(raw, 'merged.log');
  } else {
    const dir = path.dirname(raw);
    if (dir && dir !== '.' && dir !== '') fs.mkdirSync(dir, { recursive: true });
    OUT_EXPANDED = raw;
  }
} else {
  const dir = path.dirname(OUT_EXPANDED);
  if (dir && dir !== '.' && dir !== '') fs.mkdirSync(dir, { recursive: true });
}

// ──────────────────────────────────────────────────────────────
// RNG (seeded optional)
// ──────────────────────────────────────────────────────────────
let rand = Math.random;
if (SEED !== null) {
  let s = (Number(SEED) >>> 0) || 1;
  rand = () => {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;

// ──────────────────────────────────────────────────────────────
// Time helpers ([Mon DD HH:MM:SS.mmm])
// ──────────────────────────────────────────────────────────────
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function toDate(baseYYYYMMDD) {
  const [Y, M, D] = baseYYYYMMDD.split('-').map(Number);
  return new Date(Y, (M - 1), D, 0, 0, 0, 0);
}
const baseDate = toDate(BASE);
const rangeMs = DAYS * 24 * 60 * 60 * 1000;

function fmt2(n){ return String(n).padStart(2,'0'); }
function fmt3(n){ return String(n).padStart(3,'0'); }
function fmtBracketTs(ms) {
  const d = new Date(ms);
  const mon = MONTHS[d.getMonth()];
  const day = fmt2(d.getDate());
  const hh = fmt2(d.getHours());
  const mm = fmt2(d.getMinutes());
  const ss = fmt2(d.getSeconds());
  const ms3 = fmt3(d.getMilliseconds());
  return `[${mon} ${day} ${hh}:${mm}:${ss}.${ms3}]`;
}

// ──────────────────────────────────────────────────────────────
// Generators per type
// ──────────────────────────────────────────────────────────────
const TYPES = ['kernel','clip','cpcd','matter','otbr-agent','system','z3gateway','bt_player'];

const macHex = () => [...Array(6)].map(()=>randInt(0,255).toString(16).padStart(2,'0')).join(':');

function line_kernel(ts) {
  const msgPool = [
    `[  ${randInt(1000,9000)}.${randInt(100000,999999)}] wlan: Send EAPOL pkt to ${macHex()}`,
    `wlan0: `,
    `wlan: Send EAPOL pkt to ${macHex()}`,
    `woal_cfg80211_set_rekey_data return: gtk_rekey_offload is DISABLE`,
  ];
  const m = msgPool[randInt(0, msgPool.length - 1)];
  return `${fmtBracketTs(ts)} kernel:  ${m}`;
}
function line_clip(ts) {
  const pid = randInt(200, 9999);
  const pool = [
    `[CLIP_INFO] [RX.Cloudlet] Got a packet from Cloudlet (_on_cloudlet_packet:${randInt(100,999)})`,
    `\t\t\t=================================@@`,
    `\t\t\t[RX.Cloudlet] hex :  AA 08 F0 EF 00 46 82 BB`,
    `\t\t\t=================================@@`,
    `\thexstr_len: [${randInt(8,64)}]`,
    `[CLIP_INFO] \t\t\tGot MSG_CLOUDLET_RX_PKT for [EF] (_process_cloudlet_rx_pkt_msg:${randInt(100,999)})`,
    `[CLIP_INFO] \t\t\t=================================@@ (_process_cloudlet_rx_pkt_msg:${randInt(100,999)})`,
    `@@=================================`,
    `[TX.UART]@@ bin: [AA 08 F0 EF 00 46 82 BB ]`,
    `[CLIP_INFO] xACGStart : 0, xTtsListCnt : 0, xVoiceState : 1, voice_active_mic : 0, xInPlayState : 0, xInternalSoundState : 0 (voicePlayerThread:${randInt(2000,4000)})`,
    `[CLIP_INFO] [__] led msgQ get timeout (led_message_handler:${randInt(2000,3000)})`,
    `[MQTT][CLIP_INFO] [PAHO] KeepAlive Ping Try to Send. try [1`,
  ];
  const m = pool[randInt(0, pool.length - 1)];
  return `${fmtBracketTs(ts)} clip.bin[${pid}]:  ${m}`;
}
function line_cpcd(ts) {
  const pid = randInt(1000, 9999);
  const iso = new Date(ts - randInt(200,1200)).toISOString().replace('Z','Z');
  const pool = [
    `[${iso}] Info :   stdout_tracing = ${rand() > 0.5 ? 'true' : 'false'}`,
    `[${iso}] Info :   file_tracing = ${rand() > 0.5 ? 'true' : 'false'}`,
    `[${iso}] Info :   lttng_tracing = ${rand() > 0.5 ? 'true' : 'false'}`,
    `[${iso}] Info :   enable_frame_trace = ${rand() > 0.5 ? 'true' : 'false'}`,
  ];
  const m = pool[randInt(0, pool.length - 1)];
  return `${fmtBracketTs(ts)} cpcd[${pid}]:  ${m}`;
}
function line_matter(ts) {
  const pid = randInt(1500, 3000);
  const stamp = `${Math.floor(ts/1000)}.${String(randInt(100000,999999)).padStart(6,'0')}`;
  const pool = [
    `[info - Matter] Constructing service`,
    `[${stamp}][${pid}:${pid}] CHIP:-: initSealStorage Result = 0`,
    `[info - MatterDaemon] Using socket: /var/run/homey-shared-sockets/homey-matter.sock`,
    `[info - Matter] Initializing service`,
    `[${stamp}][${pid}:${pid}] CHIP:TOO: Set up stack`,
  ];
  const m = pool[randInt(0, pool.length - 1)];
  return `${fmtBracketTs(ts)} homey-matter[${pid}]:  ${m}`;
}
function line_otbr(ts) {
  const pid = randInt(1600, 2000);
  const h = fmt2(randInt(0,23));
  const m = fmt2(randInt(0,59));
  const s = fmt2(randInt(0,59));
  const ms = String(randInt(0,999)).padStart(3,'0');
  const pool = [
    `${h}:${m}:${s}.${ms} [D] P-RadioSpinel-: Received spinel frame, flg:0x2, iid:2, tid:9, cmd:PROP_VALUE_IS, key:LAST_STATUS, status:OK`,
    `${h}:${m}:${s}.${ms} [D] SubMac--------: RadioState: Transmit -> Receive`,
    `${h}:${m}:${s}.${ms} [D] Mac-----------: =================`,
  ];
  const msg = pool[randInt(0, pool.length - 1)];
  return `${fmtBracketTs(ts)} otbr-agent[${pid}]:  ${msg}`;
}
function line_system(ts) {
  if (rand() < 0.6) {
    const pool = [
      `logrotate.service: Deactivated successfully.`,
      `Finished Rotate log files.`,
    ];
    const m = pool[randInt(0, pool.length - 1)];
    return `${fmtBracketTs(ts)} systemd[1]:  ${m}`;
  } else {
    const pid = randInt(1000, 20000);
    const pool = [
      `lo        no wireless extensions.`,
      `sit0      no wireless extensions.`,
      `ip6tnl0   no wireless extensions.`,
    ];
    const m = pool[randInt(0, pool.length - 1)];
    return `${fmtBracketTs(ts)} rc.local[${pid}]:  ${m}`;
  }
}
function line_z3(ts) {
  const pid = randInt(1800, 2500);
  const pool = [
    `[info - Z3GatewayRpcService] SetUpStack`,
    `[info - Z3GatewayRpcService] StartZ3Gateway NCP path: /dev/ttyZigbeeNCP`,
    `Reset info: ${randInt(1, 20)} (SOFTWARE)`,
  ];
  const m = pool[randInt(0, pool.length - 1)];
  return `${fmtBracketTs(ts)} homey-z3gateway[${pid}]:  ${m}`;
}
function line_bt(ts) {
  const pid = randInt(100, 999);
  const t = `${fmt2(randInt(0,23))}:${fmt2(randInt(0,59))}:${fmt2(randInt(0,59))}`;
  const id = Math.floor(ts/1000);
  const pool = [
    `${t}, \x1b[32mINFO \x1b[0m \x1b[90mprint_monitor:205:\x1b[0m  MEDIA <X:X> [${id}] play[KIT_STOPPED:000/000000] LED[0] HS[0] hplay[2] H_ID(000:-01) MT[1] vol[50]`,
    `${t}, \x1b[32mINFO \x1b[0m \x1b[90mprint_monitor:223:\x1b[0m  TTS   <X:X> [${id}] play[KIT_IDLE] vol[60]`,
    `${t}, \x1b[32mINFO \x1b[0m \x1b[90mprint_monitor:191:\x1b[0m  BT    <X:X> [${id}] power[1] discov[0] conn[0[] play[0] trans[BT_TRANSPORT_DISCONNECT:BT_TRANSPORT_IDLE] vol[64])`,
  ];
  const m = pool[randInt(0, pool.length - 1)];
  return `${fmtBracketTs(ts)} bt_player[${pid}]:  ${m}`;
}

const gen = {
  kernel: line_kernel,
  clip: line_clip,
  cpcd: line_cpcd,
  matter: line_matter,
  'otbr-agent': line_otbr,
  system: line_system,
  z3gateway: line_z3,
  bt_player: line_bt,
};

// ──────────────────────────────────────────────────────────────
// Build → sort → write
// ──────────────────────────────────────────────────────────────
const N = TYPES.length;
const baseCount = Math.floor(TOTAL / N);
let remainder = TOTAL % N;
const plan = TYPES.map((t) => ({ type: t, count: baseCount + (remainder-- > 0 ? 1 : 0) }));

const events = [];
for (const { type, count } of plan) {
  const makeLine = gen[type];
  for (let i = 0; i < count; i++) {
    const tMs = baseDate.getTime() + Math.floor(rand() * rangeMs);
    events.push({ ts: tMs, text: makeLine(tMs), type });
  }
}
events.sort((a, b) => a.ts - b.ts);

// ⚠️ 파일 끝에 추가 빈 줄이 생기지 않도록 trailing newline 제거
fs.writeFileSync(OUT_EXPANDED, events.map(e => e.text).join('\n'), 'utf8');

const byType = new Map();
for (const e of events) byType.set(e.type, (byType.get(e.type) || 0) + 1);

console.log(`✅ generated: ${path.resolve(OUT_EXPANDED)}`);
for (const t of TYPES) console.log(`  - ${t.padEnd(11)}: ${String(byType.get(t) || 0).padStart(6)}`);
console.log(`  = total: ${events.length}`);