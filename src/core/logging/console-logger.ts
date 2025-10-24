// === src/core/logging/console-logger.ts ===
import * as fs from 'fs';
import * as path from 'path';
import { inspect } from 'util';
import { LOG_LEVEL_DEFAULT } from '../../shared/const.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
type Logger = { debug?: Fn; info: Fn; warn: Fn; error: Fn };
type Fn = (msg?: any, ...args: any[]) => void;

const levelRank: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLevel = (process.env.EDGE_TOOL_LOG_LEVEL || LOG_LEVEL_DEFAULT || 'debug')
  .toString()
  .toLowerCase() as Level;

function enabled(lv: Level) {
  return levelRank[lv] >= levelRank[currentLevel];
}

// Jest(테스트) 환경 감지
const IS_TEST =
  !!process.env.JEST_WORKER_ID ||
  process.env.JEST === '1' ||
  process.env.NODE_ENV === 'test';

// 테스트 시 파일로 로그를 모은다: src/__test__/out/console.log
const TEST_LOG_PATH = path.resolve(
  __dirname,
  '..', '..', '..',           // → src
  '__test__',
  'out',
  'console.log',
);

let _testWs: fs.WriteStream | null = null;
function getTestWriteStream(): fs.WriteStream {
  if (_testWs) return _testWs;
  try {
    fs.mkdirSync(path.dirname(TEST_LOG_PATH), { recursive: true });
  } catch {}
  _testWs = fs.createWriteStream(TEST_LOG_PATH, { flags: 'a', encoding: 'utf8' });
  _testWs.on('error', () => {
    // 테스트 로그 파일 쓰기 에러는 테스트 흐름에 영향 주지 않도록 무시
  });
  return _testWs;
}

function fileSinkWrite(level: Level, parts: any[]) {
  const ts = new Date().toISOString();
  const body = parts
    .filter((p) => p !== undefined)
    .map((p) =>
      typeof p === 'string'
        ? p
        : inspect(p, { depth: 5, maxArrayLength: 200, breakLength: Infinity }),
    )
    .join(' ');
  const line = `${ts} ${level.toUpperCase()} ${body}\n`;
  getTestWriteStream().write(line);
}

/** 콘솔 백엔드 로거: 호출부 포맷은 유지하고, prefix만 붙여준다. */
export function getConsoleLogger(name: string) /*: Logger*/ {
  const prefix = `[${name}]`;
  if (IS_TEST) {
    // ✅ 테스트 환경: 파일로 로그를 남긴다.
    const mk = (lv: Level): Fn => (msg?: any, ...args: any[]) => {
      if (!enabled(lv)) return;
      fileSinkWrite(lv, [prefix, msg, ...args]);
    };
    const logger: Logger = {
      info: mk('info'),
      warn: mk('warn'),
      error: mk('error'),
    };
    if (enabled('debug')) logger.debug = mk('debug');
    return logger;
  } else {
    // 일반 실행 환경: 기존처럼 콘솔에 출력
    const wrap = (fn: (...a: any[]) => void): Fn => (msg?: any, ...args: any[]) =>
      fn(prefix, msg, ...args);
    const logger: Logger = {
      info: wrap(console.log.bind(console)),
      warn: wrap(console.warn.bind(console)),
      error: wrap(console.error.bind(console)),
    };
    if (enabled('debug')) {
      logger.debug = wrap(console.debug.bind(console));
    }
    return logger;
  }
}
