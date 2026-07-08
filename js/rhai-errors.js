// ─── Rhai Runtime Error Log ────────────────────────────────────
// Tracks script errors from the Rhai engine, deduplicates them,
// and updates the HUD badge/panel.  Also installs a console.error
// interceptor to capture Rust-side script runtime errors.

import { elements } from './dom.js';

const RHAI_ERROR_LOG = [];
const MAX_RHAI_ERRORS = 30;

// ─── HTML-escape utility ─────────────────────────────────────
export function htmlEscape(str) {
    return String(str).replace(/[&<>"']/g, function (m) {
        return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[m];
    });
}

// ─── Relative time formatting ────────────────────────────────
export function formatTimeAgo(ts) {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 5) return 'just now';
    if (sec < 60) return sec + 's ago';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    return Math.floor(min / 60) + 'h ago';
}

// ─── Display update ──────────────────────────────────────────
function updateRhaiErrorDisplay() {
    const count = RHAI_ERROR_LOG.length;
    const { rhaiErrorBadge: badge, rhaiErrorPanel: panel,
            rhaiErrorHeaderCount: headerCount, rhaiErrorList: listEl } = elements;

    if (badge) {
        if (count === 0) {
            badge.style.display = 'none';
            badge.className = 'rhai-error-none';
            badge.textContent = '';
        } else {
            badge.style.display = 'inline';
            badge.className = count <= 3 ? 'rhai-error-few' : 'rhai-error-many';
            badge.textContent = count + ' ERR';
        }
    }

    if (headerCount) headerCount.textContent = count;

    if (listEl) {
        if (count === 0) {
            listEl.innerHTML = '<div class="rhai-error-empty">No errors</div>';
        } else {
            const frag = document.createDocumentFragment();
            for (let i = RHAI_ERROR_LOG.length - 1; i >= 0; i--) {
                const e = RHAI_ERROR_LOG[i];
                const ago = formatTimeAgo(e.ts);
                const catClass = e.category === 'runtime' ? 'rhai-err-runtime'
                    : e.category === 'fetch' ? 'rhai-err-fetch'
                    : 'rhai-err-load';
                const shortMsg = e.message.length > 80
                    ? e.message.slice(0, 77) + '...' : e.message;
                const div = document.createElement('div');
                div.className = 'rhai-error-entry ' + catClass;
                div.innerHTML = '<span class="rhai-err-source">' + htmlEscape(e.source)
                    + '</span> <span class="rhai-err-msg">' + htmlEscape(shortMsg)
                    + '</span> <span class="rhai-err-ago">' + htmlEscape(ago) + '</span>';
                div.title = e.message;
                frag.appendChild(div);
            }
            listEl.innerHTML = '';
            listEl.appendChild(frag);
        }
    }

    const hasNonFetchError = RHAI_ERROR_LOG.some(e => e.category !== 'fetch');
    if (hasNonFetchError && panel && panel.classList.contains('hidden')) {
        panel.classList.remove('hidden');
    }
}

// ─── Public API ──────────────────────────────────────────────

export function logRhaiError(source, message, category) {
    if (!message) return;
    const msg = String(message).trim();
    source = source || 'unknown';
    category = category || 'load';

    for (let i = RHAI_ERROR_LOG.length - 1; i >= 0; i--) {
        const e = RHAI_ERROR_LOG[i];
        if (e.source === source && e.category === category) {
            if (e.message === msg) {
                e.ts = Date.now();
                updateRhaiErrorDisplay();
                return e;
            }
            break;
        }
    }

    const entry = { source, message: msg, category, ts: Date.now(), id: RHAI_ERROR_LOG.length + 1 };
    RHAI_ERROR_LOG.push(entry);
    if (RHAI_ERROR_LOG.length > MAX_RHAI_ERRORS) RHAI_ERROR_LOG.shift();
    updateRhaiErrorDisplay();
    return entry;
}

export function clearRhaiErrorsForSource(source) {
    if (!source) return;
    const before = RHAI_ERROR_LOG.length;
    for (let i = RHAI_ERROR_LOG.length - 1; i >= 0; i--) {
        if (RHAI_ERROR_LOG[i].source === source) RHAI_ERROR_LOG.splice(i, 1);
    }
    if (RHAI_ERROR_LOG.length !== before) updateRhaiErrorDisplay();
}

export function clearRhaiErrors() {
    RHAI_ERROR_LOG.length = 0;
    updateRhaiErrorDisplay();
}

// ─── Wire clear button ───────────────────────────────────────
if (elements.rhaiErrorClear) {
    elements.rhaiErrorClear.addEventListener('click', (e) => {
        e.stopPropagation();
        clearRhaiErrors();
    });
}

// ─── Console.error interceptor ───────────────────────────────
export function installRhaiConsoleInterceptor() {
    const origError = console.error;
    console.error = function () {
        const args = Array.from(arguments);
        const joined = args.map(a => String(a)).join(' ');

        const isScriptError =
            joined.includes('[ENGINE]') || joined.includes('[SCRIPT]') ||
            joined.includes('[LUA]') || joined.includes('[RHAI]') ||
            joined.includes('[RHAI ERROR]') || joined.includes('try_call_ai_apex') ||
            joined.includes('engine.load_script') || joined.includes('engine.load_lua_script') ||
            joined.includes('run_with_scope') || joined.includes('eval_expression') ||
            joined.includes('Evaluation error') || joined.includes('Function not found') ||
            joined.includes('ErrorFunctionNotFound') || joined.includes('Syntax error') ||
            joined.includes('Script error');

        if (isScriptError) {
            let source = 'engine';
            for (const arg of args) {
                const s = String(arg);
                if (s.includes('.lua') || s.includes('.rhai')) {
                    const match = s.match(/\b([\w_-]+\.(?:lua|rhai))\b/);
                    if (match) source = match[1];
                    break;
                }
            }
            logRhaiError(source, 'Runtime: ' + joined, 'runtime');
        }

        origError.apply(console, args);
    };
}
