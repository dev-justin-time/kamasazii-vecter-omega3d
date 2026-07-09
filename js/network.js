// ─── Network: WebSocket + Puter.js ───────────────────────────
// All server communication and cloud integration in one place.

import { CONFIG } from './config.js';
import { elements } from './dom.js';
import { state } from './state.js';
import { updateHUD } from './hud.js';
import { WEAPON_DEFS } from './weapons.js';
import { setCloudStatus, initCloudRecheck, CloudState } from '../../shared/cloud-status.js';
import { dbg } from './dbg.js';

// ═══ WebSocket Multiplayer Client ══════════════════════════════
// Reconnect logic uses exponential backoff capped at 30s. Without this
// the previous fixed-3s retry storms the dev console (and downstream
// proxy logs) with one failed WebSocket connection per failed server.

const WS_RETRY_INITIAL_MS = 1000;
const WS_RETRY_MAX_MS = 30000;
let _wsRetryCount = 0;
let _wsRetryTimer = null;

function _scheduleWsReconnect() {
    if (_wsRetryTimer) return;
    // Exp backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap), 30s, ...
    const delay = Math.min(WS_RETRY_MAX_MS, WS_RETRY_INITIAL_MS * Math.pow(2, _wsRetryCount));
    _wsRetryCount++;
    _wsRetryTimer = setTimeout(() => {
        _wsRetryTimer = null;
        connectWebSocket();
    }, delay);
}

export function connectWebSocket() {
    const url = CONFIG.wsUrl + '?room=omega_arena&player_id=' + CONFIG.playerName;
    if (elements.wsDot) elements.wsDot.className = 'status-dot connecting';
    if (elements.wsStatus) elements.wsStatus.textContent = 'CONNECTING...';

    try {
        state.ws = new WebSocket(url);

        state.ws.onopen = () => {
            _wsRetryCount = 0;  // successful connect — reset backoff
            if (elements.wsDot) elements.wsDot.className = 'status-dot connected';
            if (elements.wsStatus) elements.wsStatus.textContent = 'CONNECTED';
        };

        state.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                switch (msg.type) {
                    case 'welcome':
                        dbg.log('[WS]', msg.message, 'as', msg.yourID);
                        break;
                    case 'state':
                        updateMultiplayerState(msg);
                        break;
                    case 'event':
                        dbg.log('[WS EVENT]', msg.message);
                        break;
                }
            } catch (e) {
                dbg.warn('[WS] Parse error:', e);
            }
        };

        state.ws.onclose = () => {
            if (elements.wsDot) elements.wsDot.className = 'status-dot disconnected';
            if (elements.wsStatus) elements.wsStatus.textContent = 'DISCONNECTED';
            _scheduleWsReconnect();
        };

        state.ws.onerror = () => {
            if (elements.wsDot) elements.wsDot.className = 'status-dot disconnected';
            if (elements.wsStatus) elements.wsStatus.textContent = 'ERROR';
        };
    } catch (e) {
        dbg.warn('[WS] Connection error:', e);
        _scheduleWsReconnect();
    }
}

function updateMultiplayerState(msg) {
    if (msg.players) {
        const me = msg.players.find(p => p.id === CONFIG.playerName);
        if (me) {
            state.health = me.health;
            state.energy = me.energy;
            state.score = me.score;
            updateHUD();
        }
    }

    // ─── Server projectiles ─────────────────────────────────────
    // Each `state` message carries `msg.projectiles` — server-authoritative
    // bullets/plasma/rails/missiles fired by every connected peer. We
    // normalize each into the same flat shape that `engine.get_projectiles()`
    // emits (x/y/z, px/py/pz, vx/vy/vz, color, weapon, owner_id, age, ttl),
    // so the renderer can concat WASM + peer projectiles and feed them
    // all through the existing `_renderProjectiles` line-list pipeline
    // without forking any per-weapon geometry logic.
    //
    // Server fields: { id, position:{x,y,z}, velocity:{x,y,z}, owner_id,
    //                  weapon, lifetime } (see server/main.go Projectile).
    if (Array.isArray(msg.projectiles)) {
        // Fixed 1-frame dt for the synthesized streak endpoint. Matches
        // the server's TICK_RATE = 60 Hz broadcast cadence so the streak
        // is visually consistent with WASM-local projectile streaks.
        const FRAME_DT = 1 / 60;
        // Initial lifetime on spawn — MUST match `Lifetime: 2.0` in
        // server/main.go's `case "fire"` handler (search "Lifetime: 2.0"
        // in server/main.go and update BOTH sides together). We derive
        // per-tick age as `initial - current_lifetime` so age grows
        // monotonically to ttl and the projectile despawns exactly when
        // the server drops it. If you change the server, change this
        // constant too.
        const INITIAL_LIFETIME = 2.0;
        const peerProj = [];
        for (const p of msg.projectiles) {
            if (!p || !p.position || !p.velocity) continue;
            const def = WEAPON_DEFS[p.weapon];
            const color = (def && def.color) || [1.0, 0.9, 0.5];
            peerProj.push({
                id: p.id,
                owner_id: p.owner_id,
                weapon: p.weapon,
                // Current position
                x: p.position.x,
                y: p.position.y,
                z: p.position.z,
                // Synthetic prev position: 1 frame ago along velocity.
                // Server projectiles have no homing so velocity is
                // constant across the projectile's lifetime — the streak
                // endpoint therefore matches reality.
                px: p.position.x - p.velocity.x * FRAME_DT,
                py: p.position.y - p.velocity.y * FRAME_DT,
                pz: p.position.z - p.velocity.z * FRAME_DT,
                vx: p.velocity.x,
                vy: p.velocity.y,
                vz: p.velocity.z,
                color: color,
                // Lifetime-derived age. First tick (lifetime ≈ INITIAL_LIFETIME)
                // → age ≈ 0 — fires the brief muzzle-flash effect.
                age: Math.max(0, Math.min(INITIAL_LIFETIME, INITIAL_LIFETIME - (p.lifetime || 0))),
                ttl: INITIAL_LIFETIME,
            });
        }
        state.peerProjectiles = peerProj;
    } else {
        // Clear peer snapshot when the server omits (or races an empty) list
        // so the renderer doesn't render stale projectiles across reconnects.
        if (state.peerProjectiles && state.peerProjectiles.length) {
            state.peerProjectiles = [];
        }
    }
}

export function sendInput(pitch, yaw, roll, throttle) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'input', pitch, yaw, roll, throttle }));
    }
}

export function sendFire(weapon) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'fire', fire: weapon }));
    }
}

export function sendGlitch() {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'glitch' }));
    }
}

// ═══ Cloud status indicator helper (uses shared/cloud-status.js) ─

/** Wire click-to-recheck on the cloud status pill. */
initCloudRecheck('cloud-status-indicator', async () => {
    await initPuter();
});

// ═══ Puter.js Integration ══════════════════════════════════════

export async function initPuter() {
    try {
        if (typeof puter === 'undefined') {
            setCloudStatus('cloud-status-indicator', CloudState.DISCONNECTED, 'Puter SDK not loaded — cloud features unavailable');
            return;
        }
        setCloudStatus('cloud-status-indicator', CloudState.CHECKING, 'Connecting to Puter...');

        if (puter.auth && puter.auth.isSignedIn && !puter.auth.isSignedIn()) {
            setCloudStatus('cloud-status-indicator', CloudState.DISCONNECTED, 'Sign in to Puter for cloud sync');
            return;
        }

        state.puterReady = true;
        setCloudStatus('cloud-status-indicator', CloudState.CONNECTED, 'Puter connected — cloud sync active');
        dbg.log('[PUTER] SDK initialized successfully');
    } catch (e) {
        dbg.warn('[PUTER] Init error:', e);
        setCloudStatus('cloud-status-indicator', CloudState.DISCONNECTED, 'Puter unavailable — using local storage');
    }
}

// ─── Puter AI: Generate Mission Briefing ─────────────────────

export async function generateMissionBriefing() {
    try {
        if (!state.puterReady || typeof puter === 'undefined' || !puter.ai) {
            elements.briefingText.textContent =
                'Sector Omega — Corrupted data-tower detected. Eliminate all hostile signals. ' +
                'Vector cannons online. Glitch drive standing by. Good hunting, pilot.';
            return;
        }
        elements.briefingText.textContent = 'Accessing neural grid for mission parameters...';
        const response = await puter.ai.chat(
            "Generate a 2-sentence cyberpunk mission briefing for a wireframe dogfighter. " +
            "The player must destroy a corrupted data-tower defended by neural AI fighters. " +
            "Use dramatic, gritty tone. Mention the environment (neon grid, data-scattered sky)."
        );
        elements.briefingText.textContent = response || 'Mission parameters corrupted — proceed with default directive.';
        elements.missionText.textContent = response || 'Sector Omega — eliminate all hostiles.';
    } catch (e) {
        dbg.warn('[AI] Briefing generation failed:', e);
        elements.briefingText.textContent =
            'Sector Omega — default directives loaded. Eliminate all hostiles. Good luck, pilot.';
    }
}

// ─── LocalStorage helper (offline fallback for Puter KV) ────
const KV_FALLBACK_KEY = 'omni_loadout_v1';

function loadoutFromLocal() {
    try {
        const raw = localStorage.getItem(KV_FALLBACK_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
}

function loadoutToLocal(loadout) {
    try { localStorage.setItem(KV_FALLBACK_KEY, JSON.stringify(loadout)); } catch (_) {}
}

// ─── Puter KV: Save/Load Loadout (with localStorage fallback) ─

export async function saveLoadout(loadout) {
    // Always persist locally first (offline-first)
    loadoutToLocal(loadout);

    const si = document.getElementById("sync-icon");
    const st = document.getElementById("sync-text");
    if (window.__syncErrorTimer) clearTimeout(window.__syncErrorTimer);
    function setSync(icon, msg) {
        if (si) si.textContent = icon;
        if (st) st.textContent = msg;
    }
    try {
        if (!state.puterReady || typeof puter === "undefined") {
            setSync("\u26e4", "Local");
            return;
        }
        setSync("\u23f3", "Saving...");
        await puter.kv.set("omni_loadout_v1", JSON.stringify(loadout));
        setSync("\u2601\ufe0f", "Saved");
        dbg.log("[PUTER KV] Loadout saved");
    } catch (e) {
        setSync("\u26a0\ufe0f", "Local");
        dbg.warn("[PUTER KV] Save error (local fallback active):", e);
        setTimeout(function() {
            if (st && (st.textContent === "Local" || st.textContent === "Error")) setSync("\u2601\ufe0f", "Ready");
        }, 3000);
    }
}

export async function loadLoadout() {
    // Try Puter first
    try {
        if (state.puterReady && typeof puter !== 'undefined') {
            const data = await puter.kv.get('omni_loadout_v1');
            if (data) {
                const parsed = JSON.parse(data);
                // Sync to localStorage for offline availability
                loadoutToLocal(parsed);
                return parsed;
            }
        }
    } catch (e) {
        dbg.warn('[PUTER KV] Load error, falling back to local:', e);
    }
    // Fallback to localStorage
    const local = loadoutFromLocal();
    if (local) dbg.log('[LOADOUT] Restored from localStorage (offline fallback)');
    return local;
}

// ─── Puter FS: Save Replay ───────────────────────────────────

export async function saveReplay(replayData) {
    try {
        if (!state.puterReady || typeof puter === 'undefined') {
            alert('Puter.js required for cloud saves. Sign in to save replays.');
            return;
        }
        const blob = new Blob([replayData], { type: 'application/octet-stream' });
        await puter.fs.write('/VectorStrike_Replays/match_' + Date.now() + '.bin', blob);
        dbg.log('[PUTER FS] Replay saved to cloud drive');
    } catch (e) {
        dbg.warn('[PUTER FS] Save error:', e);
    }
}

// Expose saveReplay globally (used by star_sparrow_builder.js)
window.saveReplay = saveReplay;

// ═══ Puter Auth (sign in/out) ══════════════════════════════════

const AUTH_KEYS = {
    local: 'omni_auth_user',
    cloud: 'omni_auth_user',
};

/**
 * Sign in to Puter. Triggers the OAuth popup flow.
 * On success, caches the user and updates cloud status.
 * @returns {Promise<object|null>} The signed-in user, or null on failure.
 */
export async function signIn() {
    try {
        if (typeof puter === 'undefined' || !puter.auth || typeof puter.auth.signIn !== 'function') {
            dbg.warn('[PUTER] Auth unavailable');
            return null;
        }
        setCloudStatus('cloud-status-indicator', CloudState.CHECKING, 'Signing in to Puter...');
        await puter.auth.signIn();
        const user = await puter.auth.getUser();
        if (user) {
            state.puterReady = true;
            try { localStorage.setItem(AUTH_KEYS.local, JSON.stringify(user)); } catch (_) {}
            setCloudStatus('cloud-status-indicator', CloudState.CONNECTED, 'Signed in as ' + (user.username || user.name));
            dbg.log('[PUTER] Signed in as', user.username || user.name);
            // Refresh briefing now that AI is available
            generateMissionBriefing();
        }
        return user || null;
    } catch (e) {
        dbg.warn('[PUTER] Sign in failed:', e);
        setCloudStatus('cloud-status-indicator', CloudState.DISCONNECTED, 'Sign in failed');
        return null;
    }
}

/**
 * Sign out of Puter. Clears cached user and updates cloud status.
 * @returns {Promise<boolean>}
 */
export async function signOut() {
    try {
        if (typeof puter === 'undefined' || !puter.auth || typeof puter.auth.signOut !== 'function') {
            return false;
        }
        await puter.auth.signOut();
        state.puterReady = false;
        try { localStorage.removeItem(AUTH_KEYS.local); } catch (_) {}
        setCloudStatus('cloud-status-indicator', CloudState.DISCONNECTED, 'Signed out');
        dbg.log('[PUTER] Signed out');
        return true;
    } catch (e) {
        dbg.warn('[PUTER] Sign out failed:', e);
        return false;
    }
}

/**
 * Get the cached Puter user (from memory or localStorage fallback).
 * @returns {Promise<object|null>}
 */
export async function getUser() {
    if (state.puterReady && typeof puter !== 'undefined' && puter.auth) {
        try {
            const user = await puter.auth.getUser();
            if (user) return user;
        } catch (_) {}
    }
    // localStorage fallback
    try {
        const raw = localStorage.getItem(AUTH_KEYS.local);
        return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
}

/**
 * Get the display-friendly username.
 * @returns {Promise<string|null>}
 */
export async function getUsername() {
    const user = await getUser();
    return user ? (user.username || user.name || null) : null;
}

// ═══ Leaderboard Score Sync ════════════════════════════════════

const SCORE_KEYS = {
    local: 'omni_leaderboard_v1',
    cloud: 'omni_leaderboard_v1',
};

/**
 * Submit a score to the Puter KV leaderboard.
 * Writes to localStorage immediately (offline-first), then syncs to
 * Puter KV asynchronously. Scores are stored as an array of entries
 * sorted descending by score, capped at 50.
 *
 * @param {number} score - The score to submit.
 * @param {object} [meta] - Optional: { mode, ship, kills, timestamp }.
 * @returns {Promise<boolean>}
 */
export async function submitScore(score, meta = {}) {
    const entry = {
        score: Math.floor(score),
        username: await getUsername() || 'Pilot',
        mode: meta.mode || state.gameMode || 'pvai',
        ship: meta.ship || 'star_sparrow',
        kills: meta.kills || 0,
        timestamp: Date.now(),
    };

    // Read current leaderboard
    let board = [];
    try {
        const raw = localStorage.getItem(SCORE_KEYS.local);
        if (raw) board = JSON.parse(raw);
    } catch (_) {}

    // Insert and sort descending
    board.push(entry);
    board.sort((a, b) => b.score - a.score);
    board = board.slice(0, 50); // cap at 50 entries

    // Persist locally
    try { localStorage.setItem(SCORE_KEYS.local, JSON.stringify(board)); } catch (_) {}

    // Async sync to Puter KV (fire-and-forget)
    try {
        if (state.puterReady && typeof puter !== 'undefined' && puter.kv) {
            const remoteRaw = await puter.kv.get(SCORE_KEYS.cloud);
            let remoteBoard = [];
            if (remoteRaw) {
                const parsed = typeof remoteRaw === 'string' ? JSON.parse(remoteRaw) : remoteRaw;
                if (Array.isArray(parsed)) remoteBoard = parsed;
            }
            // Merge local + remote, deduplicate by timestamp
            const merged = [...board];
            for (const r of remoteBoard) {
                if (!merged.some(e => e.timestamp === r.timestamp)) {
                    merged.push(r);
                }
            }
            merged.sort((a, b) => b.score - a.score);
            await puter.kv.set(SCORE_KEYS.cloud, JSON.stringify(merged.slice(0, 50)));
            dbg.log('[PUTER] Score synced to cloud:', entry.score);
        }
    } catch (e) {
        dbg.warn('[PUTER] Score cloud sync failed (local saved):', e);
    }

    return true;
}

/**
 * Get the leaderboard. Merges local + Puter KV, returns sorted array.
 * @returns {Promise<Array<{score, username, mode, kills, timestamp}>>}
 */
export async function getLeaderboard() {
    // Start with local data
    let board = [];
    try {
        const raw = localStorage.getItem(SCORE_KEYS.local);
        if (raw) board = JSON.parse(raw);
    } catch (_) {}

    // Try to merge from cloud
    try {
        if (state.puterReady && typeof puter !== 'undefined' && puter.kv) {
            const remoteRaw = await puter.kv.get(SCORE_KEYS.cloud);
            if (remoteRaw) {
                const parsed = typeof remoteRaw === 'string' ? JSON.parse(remoteRaw) : remoteRaw;
                if (Array.isArray(parsed)) {
                    const seen = new Set(board.map(e => e.timestamp));
                    for (const r of parsed) {
                        if (!seen.has(r.timestamp)) {
                            board.push(r);
                            seen.add(r.timestamp);
                        }
                    }
                    board.sort((a, b) => b.score - a.score);
                    board = board.slice(0, 50);
                    // Sync the merged result back to local
                    try { localStorage.setItem(SCORE_KEYS.local, JSON.stringify(board)); } catch (_) {}
                }
            }
        }
    } catch (e) {
        dbg.warn('[PUTER] Leaderboard cloud read failed (local only):', e);
    }

    return board;
}

/**
 * Get the player's best score from the leaderboard.
 * @returns {Promise<number>}
 */
export async function getBestScore() {
    const board = await getLeaderboard();
    const username = await getUsername();
    const userEntries = board.filter(e => e.username === (username || 'Pilot'));
    return userEntries.length > 0 ? Math.max(...userEntries.map(e => e.score)) : 0;
}

// Expose globally for other scripts (e.g. star_sparrow_builder DOM buttons)
window.puterSignIn = signIn;
window.puterSignOut = signOut;
window.submitScore = submitScore;
