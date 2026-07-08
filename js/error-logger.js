// ─── Client Error Logger ────────────────────────────────────────
// Catches window.onerror + unhandledrejection, dedupes within a 5s
// window, buffers up to 50 entries, and flushes to Puter FS + optional
// analytics endpoint.  Logging itself never throws.

import { CONFIG } from './config.js';
import { state } from './state.js';

const MAX_BUFFER = 50;
const FLUSH_BATCH = 20;
const DEDUP_WINDOW_MS = 5000;
const FLUSH_DEBOUNCE_MS = 2000;

const seen = new Map();
const buffer = [];
let flushTimer = null;
let flushing = false;
let analyticsCfg = { enabled: false, endpoint: null };

function makeKey(kind, message) {
    return kind + '|' + String(message || '').slice(0, 200);
}

function isDuplicate(kind, message) {
    const key = makeKey(kind, message);
    const last = seen.get(key);
    const now = Date.now();
    if (seen.size > 200) {
        for (const [k, t] of seen) {
            if (now - t > DEDUP_WINDOW_MS * 4) seen.delete(k);
        }
    }
    if (last && (now - last) < DEDUP_WINDOW_MS) {
        seen.set(key, now);
        return true;
    }
    seen.set(key, now);
    return false;
}

function report(kind, err, source) {
    let message = 'unknown';
    let stack = null;
    if (err) {
        if (typeof err === 'string') message = err;
        else if (err.message) message = err.message;
        else if (err.reason) message = String(err.reason);
        else message = String(err);
        stack = err.stack || null;
    }
    if (isDuplicate(kind, message)) return;
    const entry = {
        ts: new Date().toISOString(),
        kind,
        message: String(message).slice(0, 1000),
        source: source || null,
        stack: stack ? String(stack).slice(0, 4000) : null,
        url: location.href,
        userAgent: navigator.userAgent,
    };
    buffer.push(entry);
    if (buffer.length > MAX_BUFFER) buffer.shift();
    console.error('[CLIENT-ERROR]', kind, entry.message, source || '');
    if (analyticsCfg.enabled && analyticsCfg.endpoint) {
        try {
            fetch(analyticsCfg.endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(entry),
                keepalive: true,
            }).catch(() => {});
        } catch (_) {}
    }
    scheduleFlush();
}

function scheduleFlush() {
    if (flushTimer || flushing) return;
    if (buffer.length >= FLUSH_BATCH) { flush(); return; }
    flushTimer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
}

async function flush() {
    flushTimer = null;
    if (flushing) return;
    if (buffer.length === 0) return;
    if (typeof puter === 'undefined' || !puter || !puter.fs) return;
    if (!state.puterReady) { scheduleFlush(); return; }
    flushing = true;
    try {
        const toFlush = buffer.splice(0, buffer.length);
        const date = new Date().toISOString().slice(0, 10);
        const logPath = '/VectorStrike_Logs/errors-' + date + '.jsonl';
        const newContent = toFlush.map(e => JSON.stringify(e)).join('\n') + '\n';
        let existing = '';
        try {
            const file = await puter.fs.read(logPath);
            if (file && typeof file.text === 'function') existing = await file.text();
        } catch (_) { /* file doesn't exist yet — fine */ }
        const blob = new Blob([existing + newContent], { type: 'text/plain' });
        await puter.fs.write(logPath, blob);
    } catch (e) {
        buffer.unshift(...toFlush);
        console.warn('[CLIENT-ERROR] Puter FS write failed:', e);
    } finally {
        flushing = false;
        if (buffer.length > 0) scheduleFlush();
    }
}

function install() {
    if (CONFIG.analytics) {
        analyticsCfg = CONFIG.analytics;
    }
    if (window.__clientErrorLogger_installed) return;
    window.__clientErrorLogger_installed = true;
    window.addEventListener('error', (e) => {
        if (e && e.target && e.target !== window) {
            const t = e.target;
            const tag = (t.tagName || 'resource').toLowerCase();
            const src = t.src || t.href || null;
            report('resource', new Error('Failed to load ' + tag + (src ? ': ' + src : '')),
                tag + (src ? ' (' + src + ')' : null));
            return;
        }
        report('error', (e && (e.error || e.message)) || e,
            e && e.filename ? e.filename + ':' + e.lineno + ':' + e.colno : null);
    }, true);
    window.addEventListener('unhandledrejection', (e) => {
        report('rejection', e && e.reason, 'promise');
    });
}

export const ClientErrorLogger = Object.freeze({ install, report, flush });
