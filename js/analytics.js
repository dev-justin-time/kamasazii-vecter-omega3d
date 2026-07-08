// ─── Analytics Tracking ────────────────────────────────────────
// Provides an onObjectAdded() hook system for tracking game events
// (ship spawns, weapon fires, ship destroyed, score changes).
// Events are buffered and flushed to localStorage + Puter KV.
// Imported by main.js — hooks into the existing game loop.

import { state } from './state.js';

// ═══ Constants ═══════════════════════════════════════════════════

const MAX_BUFFER = 200;
const FLUSH_INTERVAL_MS = 15000;   // flush every 15s during gameplay
const KV_KEY = 'omni_analytics_v1';
const LOCAL_KEY = 'omni_analytics_buffer';

// ═══ Event Type Constants ═══════════════════════════════════════

export const EventType = Object.freeze({
    SHIP_SPAWN:     'ship_spawn',
    WEAPON_FIRE:    'weapon_fire',
    SHIP_DESTROYED: 'ship_destroyed',
    SCORE_CHANGE:   'score_change',
    GLITCH_DRIVE:   'glitch_drive',
    MISSION_START:  'mission_start',
    MISSION_END:    'mission_end',
});

// ═══ GameAnalytics Class ════════════════════════════════════════

export class GameAnalytics {
    constructor() {
        /** Map<EventType, Set<callback>> */
        this._listeners = new Map();

        /** In-memory event buffer */
        this._buffer = [];

        /** Session ID — unique per page load */
        this._sessionId = Date.now().toString(36) +
            Math.random().toString(36).slice(2, 6);

        /** Game tick counter at last flush */
        this._lastFlushTick = 0;

        /** Periodic flush timer handle */
        this._flushTimer = null;

        /** Previous values for delta tracking */
        this._prevHealth = {};
        this._prevScore = state.score;

        /** Auto-start periodic flush on construction */
        this._startPeriodicFlush();

        // Flush remaining events on page unload (prevents data loss)
        this._beforeUnloadHandler = () => { this.flush(); };
        window.addEventListener('beforeunload', this._beforeUnloadHandler);

        console.log('[ANALYTICS] Session started:', this._sessionId);
    }

    // ── Hook Registration ──────────────────────────────────────

    /**
     * Register a callback for a specific event type.
     * @param {string} eventType - One of EventType constants.
     * @param {(eventData: object) => void} callback - Called synchronously
     *   when the event fires. Receives { type, ts, ...data }.
     * @returns {() => void} Unsubscribe function.
     */
    on(eventType, callback) {
        if (!this._listeners.has(eventType)) {
            this._listeners.set(eventType, new Set());
        }
        this._listeners.get(eventType).add(callback);
        return () => this._listeners.get(eventType)?.delete(callback);
    }

    /**
     * Remove a specific callback for an event type.
     */
    off(eventType, callback) {
        this._listeners.get(eventType)?.delete(callback);
    }

    // ── Internal: Emit + Buffer ────────────────────────────────

    /** Fire callbacks synchronously, then buffer for persistence. */
    _emit(eventType, data) {
        const event = {
            type: eventType,
            ts: new Date().toISOString(),
            sessionId: this._sessionId,
            gameTick: state.frameCount || 0,
            gameMode: state.gameMode || 'unknown',
            ...data,
        };

        // Notify registered listeners (synchronous)
        const callbacks = this._listeners.get(eventType);
        if (callbacks) {
            for (const cb of callbacks) {
                try { cb(event); } catch (e) {
                    console.warn('[ANALYTICS] Listener error:', e);
                }
            }
        }

        // Buffer for persistence
        this._buffer.push(event);
        if (this._buffer.length >= MAX_BUFFER) {
            this.flush();
        }
    }

    // ── Public Tracking Methods (called from main.js) ──────────

    /**
     * Track a ship spawn / reset.
     * @param {string} shipId - 'player_1', 'player_2', or 'enemy_apex'.
     * @param {string} shipModelKey - e.g. 'f22_raptor'.
     */
    trackShipSpawn(shipId, shipModelKey) {
        this._prevHealth[shipId] = 100;
        this._emit(EventType.SHIP_SPAWN, {
            shipId,
            shipModel: shipModelKey || null,
            health: 100,
            energy: 100,
        });
    }

    /**
     * Track a weapon fire (projectile created).
     * @param {string} weaponKey - e.g. 'plasma_bolt'.
     * @param {string} shipId - The ship that fired.
     * @param {object} [extra] - Optional extra data like position.
     */
    trackWeaponFire(weaponKey, shipId, extra) {
        this._emit(EventType.WEAPON_FIRE, {
            weapon: weaponKey,
            shipId,
            ...(extra || {}),
        });
    }

    /**
     * Track that a ship was destroyed.
     * @param {string} shipId - The destroyed ship.
     * @param {string|null} killerId - The ship that killed it (if known).
     */
    trackShipDestroyed(shipId, killerId) {
        this._emit(EventType.SHIP_DESTROYED, {
            shipId,
            killerId: killerId || null,
        });
    }

    /**
     * Track a score change.
     * @param {number} newScore - Current score value.
     * @param {number} delta - Change from previous score.
     */
    trackScoreChange(newScore, delta) {
        this._emit(EventType.SCORE_CHANGE, {
            score: newScore,
            delta,
        });
    }

    /**
     * Track glitch drive activation.
     * @param {string} shipId - The ship that glitched.
     */
    trackGlitchDrive(shipId) {
        this._emit(EventType.GLITCH_DRIVE, {
            shipId,
        });
    }

    /**
     * Track mission start (briefing → arena).
     * @param {string} mode - 'pvai' or 'pvp'.
     */
    trackMissionStart(mode) {
        this._emit(EventType.MISSION_START, {
            mode,
            playerName: state.playerName || 'unknown',
        });
    }

    // ── Game Loop Monitoring (called each tick from main.js) ───

    /**
     * Call each frame to detect health/score changes.
     * Uses previous-frame values for delta tracking.
     * @param {Array<{id: string, health: number}>} shipPositions - Parsed
     *   from engine.get_ship_positions().
     */
    monitor(shipPositions) {
        if (!shipPositions || !Array.isArray(shipPositions)) return;

        for (const ship of shipPositions) {
            const prevHealth = this._prevHealth[ship.id];
            if (prevHealth !== undefined) {
                // Health decreased → damage taken
                if (ship.health < prevHealth && prevHealth > 0) {
                    // If health dropped to 0 or below → destroyed
                    if (ship.health <= 0) {
                        this.trackShipDestroyed(ship.id, null);
                    }
                }
                // Health increased from 0 → respawn (detected by reset_ships)
                // Handled via trackShipSpawn instead.
            }
            this._prevHealth[ship.id] = ship.health;
        }

        // Score change detection
        if (state.score !== this._prevScore) {
            const delta = state.score - this._prevScore;
            this.trackScoreChange(state.score, delta);
            this._prevScore = state.score;
        }
    }

    // ── Flush / Persistence ────────────────────────────────────

    /** Force-flush buffered events to localStorage + Puter KV. */
    async flush() {
        if (this._buffer.length === 0) return;

        const batch = this._buffer.splice(0, this._buffer.length);

        // Always persist to localStorage (offline-first)
        try {
            const existing = JSON.parse(
                localStorage.getItem(LOCAL_KEY) || '[]'
            );
            const merged = existing.concat(batch);
            // Keep only the last 500 events in local storage
            const trimmed = merged.length > 500
                ? merged.slice(merged.length - 500)
                : merged;
            localStorage.setItem(LOCAL_KEY, JSON.stringify(trimmed));
        } catch (_) { /* localStorage unavailable — skip */ }

        // Async flush to Puter KV (fire-and-forget)
        this._flushToPuter(batch).catch(() => {});
    }

    /** Write events to Puter KV (fire-and-forget, never throws). */
    async _flushToPuter(batch) {
        try {
            if (typeof puter === 'undefined' || !puter || !puter.kv) return;
            if (!state.puterReady) return;

            // Read existing analytics log
            let existing = [];
            try {
                const raw = await puter.kv.get(KV_KEY);
                if (raw) {
                    const parsed = typeof raw === 'string'
                        ? JSON.parse(raw)
                        : raw;
                    if (Array.isArray(parsed)) existing = parsed;
                }
            } catch (_) { /* key may not exist yet */ }

            const merged = existing.concat(batch);
            const trimmed = merged.length > 1000
                ? merged.slice(merged.length - 1000)
                : merged;

            await puter.kv.set(KV_KEY, JSON.stringify(trimmed));
        } catch (_) {
            /* Puter unavailable — events still in localStorage */
        }
    }

    /** Start a periodic flush interval (cleaned up on stop). */
    _startPeriodicFlush() {
        this._stopPeriodicFlush();
        this._flushTimer = setInterval(() => {
            // Skip flush if no game session is active
            if (!state.running && this._buffer.length === 0) return;
            this.flush();
        }, FLUSH_INTERVAL_MS);
        // Allow the timer to not block process exit
        if (this._flushTimer && this._flushTimer.unref) {
            this._flushTimer.unref();
        }
    }

    _stopPeriodicFlush() {
        if (this._flushTimer) {
            clearInterval(this._flushTimer);
            this._flushTimer = null;
        }
    }

    /**
     * Stop analytics and flush remaining events.
     * Call this on page unload or when analytics is no longer needed.
     */
    async stop() {
        this._stopPeriodicFlush();
        window.removeEventListener('beforeunload', this._beforeUnloadHandler);
        await this.flush();
        this._listeners.clear();
    }
}

// ─── Singleton ──────────────────────────────────────────────────

/** Shared GameAnalytics instance used across the app. */
export const analytics = new GameAnalytics();
