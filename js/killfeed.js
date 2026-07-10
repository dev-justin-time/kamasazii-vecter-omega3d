// ─── Kill Feed & PvP Scoring ────────────────────────────────────
// Per-player kill tracking, kill-feed display, respawn mechanics.
// Integrates with the WASM engine's health-diff detection.

import { state } from './state.js';
import { SPAWN_ZONES } from './boundaries.js';

// ─── Kill feed state ─────────────────────────────────────────
const FEED_MAX = 5;                  // max entries shown
const FEED_TTL = 4.0;               // seconds each entry stays
const RESPAWN_DELAY = 3.0;          // seconds before respawn

let _killFeed = [];                  // { killer, victim, weapon, time }
let _score = { player_1: 0, player_2: 0, enemy_apex: 0 };
let _deathTimers = {};               // ship id → remaining respawn seconds
let _deadShips = new Set();          // ships currently waiting to respawn
let _prevHealth = new Map();         // track health for kill detection

// ─── DOM refs (set during init) ──────────────────────────────
let _feedEl = null;
let _scoreP1El = null;
let _scoreP2El = null;
let _respawnOverlayEl = null;

/**
 * Initialize kill feed. Call once during setup.
 */
export function initKillFeed() {
    _feedEl = document.getElementById('kill-feed');
    _scoreP1El = document.getElementById('kill-score-p1');
    _scoreP2El = document.getElementById('kill-score-p2');
    _respawnOverlayEl = document.getElementById('respawn-overlay');
}

/**
 * Check ship health for kills/deaths each tick.
 * @param {Array} shipData - From engine.get_ship_positions()
 * @param {number} dt - Delta time
 */
export function checkKills(shipData, dt) {
    if (!shipData || !Array.isArray(shipData)) return;

    // ─── Process respawn timers ──────────────────────────────
    for (const id of Object.keys(_deathTimers)) {
        _deathTimers[id] -= dt;
        if (_deathTimers[id] <= 0) {
            respawnShip(id);
            delete _deathTimers[id];
            _deadShips.delete(id);
        }
    }

    // ─── Update respawn overlay for player_1 ─────────────────
    if (_respawnOverlayEl) {
        const timer = _deathTimers['player_1'];
        if (timer && timer > 0) {
            _respawnOverlayEl.style.visibility = 'visible';
            _respawnOverlayEl.textContent = 'RESPAWN IN ' + Math.ceil(timer) + 's';
        } else if (_respawnOverlayEl.style.visibility === 'visible') {
            _respawnOverlayEl.style.visibility = 'hidden';
        }
    }

    // ─── Detect kills (health dropping to 0) ─────────────────
    for (const ship of shipData) {
        const prev = _prevHealth.get(ship.id);
        _prevHealth.set(ship.id, ship.health);

        // Ship just died
        if (prev !== undefined && prev > 0 && ship.health <= 0 && !_deadShips.has(ship.id)) {
            _deadShips.add(ship.id);
            _deathTimers[ship.id] = RESPAWN_DELAY;

            // Determine killer (last projectile owner that hit this ship)
            const killer = determineKiller(ship.id);

            // Update score
            if (killer && _score[killer] !== undefined) {
                _score[killer]++;
            }

            // Add to kill feed
            const entry = {
                killer: killer || 'arena',
                victim: formatShipName(ship.id),
                weapon: 'destruction',
                time: performance.now(),
            };
            _killFeed.unshift(entry);
            if (_killFeed.length > FEED_MAX) _killFeed.length = FEED_MAX;

            // Update HUD
            updateScoreDisplay();
            updateKillFeedDisplay();
        }
    }

    // ─── Clean up stale entries ──────────────────────────────
    for (const id of [..._prevHealth.keys()]) {
        if (!shipData.some(s => s.id === id)) _prevHealth.delete(id);
    }

    // ─── Age kill feed entries ────────────────────────────────
    const now = performance.now();
    let changed = false;
    for (let i = _killFeed.length - 1; i >= 0; i--) {
        if (now - _killFeed[i].time > FEED_TTL * 1000) {
            _killFeed.splice(i, 1);
            changed = true;
        }
    }
    if (changed) updateKillFeedDisplay();
}

/**
 * Respawn a dead ship at its spawn zone.
 */
function respawnShip(shipId) {
    if (!state.engine) return;
    const spawn = SPAWN_ZONES[shipId];
    if (!spawn) return;

    // The Rust engine doesn't have a per-ship respawn — we reset ships
    // for the current mode. For PvP, respawn both ships to reset positions
    // but preserve scores.
    const mode = state.gameMode === 'pvp' ? 'pvp' : 'pvai';
    try {
        state.engine.reset_ships(mode);
    } catch (_) {}
}

/**
 * Try to determine who killed a ship.
 * Checks recent projectile hits from health diff detection in renderer.js.
 */
function determineKiller(victimId) {
    // The renderer tracks health changes via _prevShipHealth in renderer.js
    // We use a simplified heuristic: if victim is enemy_apex, killer is player_1.
    // For PvP, we could track projectile ownership via the engine.
    if (victimId === 'enemy_apex') return 'player_1';
    if (victimId === 'player_1') {
        return state.gameMode === 'pvp' ? 'player_2' : 'enemy_apex';
    }
    if (victimId === 'player_2') return 'player_1';
    return null;
}

function formatShipName(id) {
    const names = {
        player_1: 'P1 RAPTOR',
        player_2: 'P2 CORSAIR',
        enemy_apex: 'AI APEX',
    };
    return names[id] || id.toUpperCase();
}

function updateScoreDisplay() {
    if (_scoreP1El) _scoreP1El.textContent = _score.player_1;
    if (_scoreP2El) _scoreP2El.textContent = _score.player_2;
}

function updateKillFeedDisplay() {
    if (!_feedEl) return;

    const now = performance.now();
    let html = '';

    for (const entry of _killFeed) {
        const age = (now - entry.time) / 1000;
        const fade = Math.max(0, 1 - age / FEED_TTL);
        const alpha = fade.toFixed(2);

        let killerColor = 'var(--neon-green)';
        if (entry.killer === 'player_2') killerColor = 'var(--neon-pink)';
        else if (entry.killer === 'enemy_apex' || entry.killer === 'arena') killerColor = 'var(--neon-red)';

        html += '<div class="kill-entry" style="opacity:' + alpha + '">' +
            '<span style="color:' + killerColor + '">' + entry.killer + '</span>' +
            '  ✦  ' +
            '<span style="color:var(--text-dim)">' + entry.victim + '</span>' +
        '</div>';
    }

    _feedEl.innerHTML = html;
}

/**
 * Get current scores.
 */
export function getScores() {
    return { ..._score };
}

/**
 * Reset scores for a new match.
 */
export function resetScores() {
    _score = { player_1: 0, player_2: 0, enemy_apex: 0 };
    _killFeed = [];
    _deathTimers = {};
    _deadShips.clear();
    _prevHealth.clear();
    updateScoreDisplay();
    if (_feedEl) _feedEl.innerHTML = '';
}

/**
 * Reset all killfeed state for a new match (scores + death state).
 * Call this instead of resetScores when restarting mid-match.
 */
export function fullReset() {
    resetScores();
    _deathTimers = {};
    _deadShips.clear();
    _prevHealth.clear();
}
