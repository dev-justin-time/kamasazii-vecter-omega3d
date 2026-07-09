// Shim — re-exports the canonical shared/error-logger.js with this
// project's per-project options pre-configured via the install() call.

import { CONFIG } from './config.js';
import { state } from './state.js';
import { ClientErrorLogger as SharedLogger } from '../../shared/error-logger.js';

export const ClientErrorLogger = Object.freeze({
  install: () => SharedLogger.install({
    logDir: '/VectorStrike_Logs',
    getAnalyticsConfig: () => CONFIG.analytics || { enabled: false },
    isPuterReady: () => state.puterReady,
  }),
  report: SharedLogger.report,
  flush:  SharedLogger.flush,
});
