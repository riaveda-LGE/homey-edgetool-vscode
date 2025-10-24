// === src/core/logging/console-logger.ts ===
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

/** 콘솔 백엔드 로거: 호출부 포맷은 유지하고, prefix만 붙여준다. */
export function getConsoleLogger(name: string) /*: Logger*/ {
  const prefix = `[${name}]`;
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
