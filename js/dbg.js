/**
 * Debug helper — gates all console output behind window.DEBUG.
 *
 * Usage:
 *   import { dbg } from './dbg.js';
 *   dbg.warn('Something happened', err);
 *   dbg.log('Info');
 *   dbg.error('Fatal');
 *
 * Set `window.DEBUG = true` in DevTools before modules load
 * to re-enable logging.
 */

const DBG = typeof window !== 'undefined' && window.DEBUG === true;

export const dbg = {
  warn: (...args) => { if (DBG) console.warn(...args); },
  error: (...args) => { if (DBG) console.error(...args); },
  log: (...args) => { if (DBG) console.log(...args); },
};
