// Shim — re-exports the canonical shared/dbg.js so existing
// `import { dbg } from './dbg.js';` call sites in this project
// keep working unchanged.
export { dbg } from '../../shared/dbg.js';
