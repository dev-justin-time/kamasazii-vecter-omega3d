// ─── Script Hot-Reload ───────────────────────────────────────
// Polls script files (e.g. weapons.rhai) for changes and re-loads
// them into the engine without requiring a full page refresh.
// Each file's content is cached and compared on each poll cycle.

import { CONFIG } from './config.js';
import { elements } from './dom.js';
import { logRhaiError, clearRhaiErrorsForSource } from './rhai-errors.js';
import { syncWeaponsFromEngine } from './weapon-select.js';

let _hotReloadTimer = null;
const _hotReloadCache = new Map();

/**
 * Start polling the configured script files for changes.
 * @param {object} engine - Rust GameEngine instance (may be null)
 * @returns {function} stop() — call to halt polling
 */
export function startRhaiHotReload(engine) {
    if (_hotReloadTimer) {
        clearInterval(_hotReloadTimer);
        _hotReloadTimer = null;
    }

    if (!engine || !CONFIG.hotReload.enabled) {
        if (elements.hotReload) {
            elements.hotReload.textContent = 'RHAI: STATIC';
            elements.hotReload.className = 'hr-idle';
        }
        return () => {};
    }

    const { scripts, intervalMs } = CONFIG.hotReload;

    async function primeCache() {
        for (const s of scripts) {
            try {
                const resp = await fetch(s.path + '?_=' + Date.now());
                if (!resp.ok) {
                    logRhaiError(s.name, 'Initial load — HTTP ' + resp.status + ' (file not found or unavailable)', 'fetch');
                } else {
                    _hotReloadCache.set(s.path, await resp.text());
                    clearRhaiErrorsForSource(s.name);
                }
            } catch (_) {
                logRhaiError(s.name, 'Initial load — fetch failed (script not served by dev server)', 'fetch');
            }
        }
    }

    primeCache().then(() => {
        if (elements.hotReload) {
            elements.hotReload.textContent = 'RHAI: WATCHING';
            elements.hotReload.className = 'hr-watching';
        }

        _hotReloadTimer = setInterval(async () => {
            for (const s of scripts) {
                try {
                    const bustUrl = s.path + '?_=' + Date.now();
                    const resp = await fetch(bustUrl);
                    if (!resp.ok) {
                        logRhaiError(s.name, 'HTTP ' + resp.status + ' ' + resp.statusText, 'fetch');
                        continue;
                    }

                    const content = await resp.text();
                    const prev = _hotReloadCache.get(s.path);

                    if (prev !== undefined && prev !== content) {
                        _hotReloadCache.set(s.path, content);
                        try {
                            engine.load_script(content);
                            console.log('[HOT-RELOAD]', s.name, 'reloaded',
                                '(' + content.length + ' chars,' + (content.length - prev.length) + ' diff)');

                            if (elements.hotReload) {
                                elements.hotReload.textContent = s.name + ' ✓';
                                elements.hotReload.className = 'hr-reloaded';
                                setTimeout(() => {
                                    elements.hotReload.textContent = 'RHAI: WATCHING';
                                    elements.hotReload.className = 'hr-watching';
                                }, 2000);
                            }

                            clearRhaiErrorsForSource(s.name);

                            if (s.name === 'weapons.rhai') {
                                syncWeaponsFromEngine(engine);
                                console.log('[HOT-RELOAD] Weapons re-synced from engine');
                            }
                        } catch (loadErr) {
                            const loadErrMsg = String(loadErr);
                            console.error('[HOT-RELOAD]', s.name, 'reload FAILED:', loadErrMsg);
                            logRhaiError(s.name, 'Parse error: ' + loadErrMsg, 'load');
                            if (elements.hotReload) {
                                elements.hotReload.textContent = s.name + ' ✗';
                                elements.hotReload.className = 'hr-error';
                                setTimeout(() => {
                                    elements.hotReload.textContent = 'RHAI: WATCHING';
                                    elements.hotReload.className = 'hr-watching';
                                }, 3000);
                            }
                        }
                    } else if (prev === undefined) {
                        _hotReloadCache.set(s.path, content);
                    }
                } catch (e) {
                    const errMsg = String(e);
                    console.warn('[HOT-RELOAD] Fetch failed:', errMsg);
                    logRhaiError(s.name, 'Fetch failed: ' + errMsg, 'fetch');
                    if (elements.hotReload) {
                        elements.hotReload.textContent = 'RHAI: ERR';
                        elements.hotReload.className = 'hr-error';
                        setTimeout(() => {
                            elements.hotReload.textContent = 'RHAI: WATCHING';
                            elements.hotReload.className = 'hr-watching';
                        }, 2000);
                    }
                }
            }
        }, intervalMs);
    });

    return () => {
        clearInterval(_hotReloadTimer);
        _hotReloadTimer = null;
        _hotReloadCache.clear();
        if (elements.hotReload) {
            elements.hotReload.textContent = 'RHAI: STOPPED';
            elements.hotReload.className = 'hr-idle';
        }
    };
}
