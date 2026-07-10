// ─── Main Entry Point ──────────────────────────────────────────
// Boot sequence, WASM engine loader, game loop, event wiring.
// This is the single entry point loaded from index.html.

// CONFIG is imported directly by each module that needs it — not needed here
import { elements, canvas, gl } from './dom.js';
import { state } from './state.js';
import { WEAPON_DEFS, WEAPON_ORDER } from './weapons.js';
// NOTE: cycleWeapon + selectWeaponByIndex are in weapon-select.js (imported below)
import { ClientErrorLogger } from './error-logger.js';
import { installRhaiConsoleInterceptor } from './rhai-errors.js';
import { initWebGL } from './renderer.js';
import { loadArena, ARENA } from './arena.js';
import { SHIPS, loadShipGLB, loadoutIdx } from './ships.js';
// selectShipLoadout is side-effect only (button wiring in ships.js) — no need to import
import { keys, pointer, getPlayer2Input } from './input.js';
import { updateHUD } from './hud.js';
import { connectWebSocket, initPuter, generateMissionBriefing, saveLoadout, loadLoadout, sendFire } from './network.js';
import { syncWeaponsFromEngine } from './weapon-select.js';
// cycleWeapon + selectWeaponByIndex are consumed by input.js, not main.js
import { startRhaiHotReload } from './hot-reload.js';
import { analytics, EventType } from './analytics.js';
import { dbg } from './dbg.js';
import { initRadar, updateRadar, isRadarReady } from './radar.js';
import { initBoundaries, renderBoundaries, enforceBoundaries, updateBoundaryWarning } from './boundaries.js';
import { initKillFeed, checkKills, fullReset } from './killfeed.js';

// ─── Boot ─────────────────────────────────────────────────────

async function loadWasmEngine() {
    try {
        const wasm = await import('../pkg/vector_strike_core.js');
        await wasm.default();
        const engine = new wasm.GameEngine();
        elements.engineVer.textContent = 'v' + (engine.version ? engine.version() : '0.1.0');
        return engine;
    } catch (e) {
        dbg.error('[WASM] Failed to load engine:', e);
        elements.loading.querySelector('.loading-text').textContent = 'WASM load failed: ' + e.message;
        ClientErrorLogger.report('wasm', e, 'loadWasmEngine');
        return null;
    }
}

async function init() {
    ClientErrorLogger.install();
    installRhaiConsoleInterceptor();

    // WebGL + scene
    initWebGL();
    await Promise.all([
        loadArena(),
        ...Object.entries(SHIPS.paths).map(([name, url]) => loadShipGLB(name, url)),
    ]);

    // Register analytics hooks before engine is ready
    _registerAnalyticsHooks();

    // Cloud services (non-blocking)
    initPuter();
    generateMissionBriefing();

    // WASM engine
    const engine = await loadWasmEngine();
    if (engine) {
        state.engine = engine;
        // Initialize WebGL inside the WASM engine (shader compilation, uniform setup)
        try {
            engine.init_gl('gameCanvas');
        } catch (e) {
            dbg.warn('[WASM] init_gl failed (renderer will use JS fallback):', e);
        }
        syncWeaponsFromEngine(engine);
        startRhaiHotReload(engine);
    }

    // Restore persisted mode only (UI elements for loadout were removed)
    const saved = await loadLoadout();
    if (saved && saved.mode) setGameMode(saved.mode);

    // Initialize radar, boundaries, and kill feed after WebGL is ready
    initRadar('radar-container');
    initBoundaries();
    initKillFeed();

    // Done loading — auto-launch straight into dogfight
    elements.loading.style.display = 'none';
    _launchGame();

    requestAnimationFrame(gameLoop);
}

// ─── Game Loop ────────────────────────────────────────────────

let lastTime = performance.now();
let tickAccumulator = 0;
const TICK_RATE = 60;
const TICK_DT = 1 / TICK_RATE;

function gameLoop(time) {
    const dt = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;

    // FPS counter
    state.frameCount++;
    if (time - state.lastFpsUpdate > 1000) {
        state.fps = state.frameCount;
        state.frameCount = 0;
        state.lastFpsUpdate = time;
        elements.fps.textContent = state.fps + ' FPS';
    }

    // Fixed timestep accumulation
    tickAccumulator += dt;
    while (tickAccumulator >= TICK_DT) {
        fixedUpdate(TICK_DT);
        tickAccumulator -= TICK_DT;
    }

    // Render (always — visible behind briefing overlay)
    if (state.render) state.render();

    requestAnimationFrame(gameLoop);
}

function fixedUpdate(dt) {
    // ── Read input ────────────────────────────────────────────
    const kPitch = (keys['w'] ? -0.5 : 0) + (keys['s'] ? 0.5 : 0);
    const kYaw = (keys['a'] ? -0.5 : 0) + (keys['d'] ? 0.5 : 0);
    const kRoll = (keys['q'] ? -0.5 : 0) + (keys['e'] ? 0.5 : 0);
    const kThrottle = (keys['shift'] || keys['w']) ? 0.8 : 0;

    const tPitch = pointer.active
        ? -Math.max(-1, Math.min(1, (pointer.y - pointer.startY) / (window.innerHeight * 0.35)))
        : 0;
    const tYaw = pointer.active
        ? Math.max(-1, Math.min(1, (pointer.x - pointer.startX) / (window.innerWidth * 0.35)))
        : 0;

    const pitch = pointer.active ? tPitch : kPitch;
    const yaw = pointer.active ? tYaw : kYaw;
    const roll = pointer.active ? 0 : kRoll;
    const throttle = pointer.active ? 0.8 : kThrottle;

    const wantsFire = keys[' '] || pointer.tapped || pointer.firePressed;
    pointer.tapped = false;

    // ── Engine tick ───────────────────────────────────────────
    if (state.engine) {
        state.engine.set_player_input(pitch, yaw, roll, throttle, dt);

        if (state.gameMode === 'pvp') {
            const p2 = getPlayer2Input();
            state.engine.set_player2_input(p2.pitch, p2.yaw, p2.roll, p2.throttle, dt);
        }

        state.engine.tick(dt);

        // Analytics monitor — detect health changes + score changes each tick
        try {
            const shipData = JSON.parse(state.engine.get_ship_positions());
            analytics.monitor(shipData);
        } catch (_) {}

        // Sync HUD from engine
        try {
            const shipData = JSON.parse(state.engine.get_ship_positions());
            const player = shipData.find(s => s.id === 'player_1');
            if (player) {
                state.health = player.health;
                state.energy = player.energy;
                state.glitchReady = !!player.glitch_ready;
                if (elements.posDisplay) {
                    elements.posDisplay.textContent =
                        Math.round(player.x) + ', ' + Math.round(player.y) + ', ' + Math.round(player.z);
                }
            }
            if (state.gameMode === 'pvp') {
                const p2Ship = shipData.find(s => s.id === 'player_2');
                if (p2Ship) {
                    state.p2.health = p2Ship.health;
                    state.p2.energy = p2Ship.energy;
                    state.p2.glitchReady = !!p2Ship.glitch_ready;
                }
            }
            // ── Arena boundary enforcement ────────────────────
            enforceBoundaries(shipData, dt);
            // ── Kill feed detection ───────────────────────────
            checkKills(shipData, dt);
            // ── Radar update ──────────────────────────────────
            if (isRadarReady()) {
                let projData = [];
                try { projData = JSON.parse(state.engine.get_projectiles()); } catch (_) {}
                updateRadar(shipData, projData);
            }
            // ── Cockpit instruments (reuse parsed shipData) ───
            updateCockpitOverlay(shipData);
        } catch (_) {}
    }

    // ── Weapon cooldowns ──────────────────────────────────────
    for (const key of WEAPON_ORDER) {
        if (state.weaponCooldowns[key] > 0) {
            state.weaponCooldowns[key] = Math.max(0, state.weaponCooldowns[key] - dt);
        }
    }

    // ── Fire weapon ───────────────────────────────────────────
    let p2Fire = false;
    if (state.gameMode === 'pvp') {
        // Player 2 fires on Enter while PvP mode is active. Cooldowns are
        // shared with player_1 for simplicity (single weapon-inventory UI),
        // but projectiles spawn from P2's muzzle and travel toward P1.
        p2Fire = !!keys['enter'];
    }

    if (wantsFire) {
        const def = WEAPON_DEFS[state.weapon];
        const cd = state.weaponCooldowns[state.weapon] || 0;
        if (def && cd <= 0 && state.energy >= def.energy_cost && state.heat + def.heat_generation < 100) {
            state.energy -= def.energy_cost;
            state.heat += def.heat_generation;
            state.weaponCooldowns[state.weapon] = def.cooldown;
            if (state.engine) {
                try { state.engine.fire_weapon(state.weapon); } catch (_) {}
            }
            // Analytics: track weapon fire (projectile created)
            analytics.trackWeaponFire(state.weapon, 'player_1');
            sendFire(state.weapon);
        }
    }

    // ── Player 2 fire (PvP only) ───────────────────────────────────
    if (p2Fire) {
        // P2 shares P1's weapon cooldown so the UI doesn't desync.
        const def = WEAPON_DEFS[state.weapon];
        const cd = state.weaponCooldowns[state.weapon] || 0;
        if (def && cd <= 0 && state.p2.energy >= def.energy_cost) {
            state.p2.energy -= def.energy_cost;
            state.weaponCooldowns[state.weapon] = def.cooldown;
            if (state.engine) {
                try { state.engine.player2_fire_weapon(state.weapon); } catch (_) {}
            }
            analytics.trackWeaponFire(state.weapon, 'player_2');
        }
    }

    // ── Heat dissipation ──────────────────────────────────────
    state.heat = Math.max(0, state.heat - 15 * dt);

    // ── Update HUD ────────────────────────────────────────────
    updateHUD();
    // ── Cockpit overlay + crosshair toggle ──────────
    updateCockpitOverlay();
    // ── Boundary warning overlay ────────────────────
    updateBoundaryWarning(dt);

    // ── PvP HUD ───────────────────────────────────────────────
    if (state.gameMode === 'pvp') {
        elements.p2HealthVal.textContent = Math.round(state.p2.health);
        elements.p2HealthBar.style.width = Math.max(0, state.p2.health) + '%';
        elements.p2EnergyVal.textContent = Math.round(state.p2.energy);
        elements.p2EnergyBar.style.width = Math.max(0, state.p2.energy) + '%';
        elements.p2GlitchStatus.textContent = state.p2.glitchReady ? 'READY' : 'COOLDOWN';
        elements.p2GlitchStatus.style.color = state.p2.glitchReady ? 'var(--neon-green)' : 'var(--text-dim)';
    }
}

// ─── Mode Switching ───────────────────────────────────────────

function setGameMode(mode) {
    state.gameMode = mode;
    if (elements.modeIndicator) elements.modeIndicator.textContent = mode.toUpperCase();
    if (elements.pvpStatus) elements.pvpStatus.classList.toggle('hidden', mode !== 'pvp');
    if (mode === 'pvp') {
        SHIPS.assignments.player_2 = SHIPS.available[loadoutIdx.player_2]?.key || 'corsair_plane';
    } else {
        SHIPS.assignments.player_2 = 'corsair_plane';
    }
    saveLoadout({ player_1: SHIPS.assignments.player_1, player_2: SHIPS.assignments.player_2, mode });
}

// ─── Launch Game (auto-starts on load — no briefing screen) ─────────────

function _launchGame() {
    state.running = true;
    if (state.engine) {
        const mode = state.gameMode === 'pvp' ? 'pvp' : 'pvai';
        state.engine.reset_ships(mode);
        try {
            const ships = JSON.parse(state.engine.get_ship_positions());
            for (const s of ships) {
                analytics.trackShipSpawn(s.id, SHIPS.assignments[s.id]);
            }
            analytics.trackMissionStart(mode);
        } catch (_) {}
    }
    fullReset();
    connectWebSocket();
}

// ─── Event Listeners ─────────────────────────────────

// Mode switching via keyboard — press M to toggle PvAI / PvP
window.addEventListener('keydown', (e) => {
    if (e.key === 'm' || e.key === 'M') {
        if (!state.running) return;
        e.preventDefault();
        setGameMode(state.gameMode === 'pvai' ? 'pvp' : 'pvai');
        if (state.engine) {
            state.engine.reset_ships(state.gameMode === 'pvp' ? 'pvp' : 'pvai');
        }
        fullReset();
    }
});

// ─── Resize ───────────────────────────────────────────────────
window.addEventListener('resize', () => {
    if (canvas && gl) {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        gl.viewport(0, 0, canvas.width, canvas.height);
    }
});

// ─── Cockpit overlay toggling ───────────────────────────────

function updateCockpitOverlay(shipData) {
    const cockpitEl = document.getElementById('cockpit-overlay');
    const crosshairEl = document.getElementById('crosshair');
    // Always in first-person view now — cockpit image IS the plane
    const showCockpit = state.running;

    if (cockpitEl) cockpitEl.classList.toggle('cockpit-visible', showCockpit);
    if (crosshairEl) crosshairEl.classList.toggle('crosshair-visible', showCockpit);
}

// ─── Expose globals for star_sparrow_builder.js ───────────────
if (gl) window.__SS_gl = gl;
if (typeof ARENA !== 'undefined') window.__SS_ARENA = ARENA;

// After engine loads, expose state and SHIPS
setTimeout(() => {
    window.__SS_SHIPS = SHIPS;
    window.__SS_state = state;
}, 0);

// ─── Analytics: Register onObjectAdded hook listeners ────────

function _registerAnalyticsHooks() {
    // Example: log all ship spawn events to console during development
    analytics.on(EventType.SHIP_SPAWN, (event) => {
        dbg.log('[ANALYTICS] Ship spawned:', event.shipId, event.shipModel);
    });

    analytics.on(EventType.WEAPON_FIRE, (event) => {
        dbg.log('[ANALYTICS] Weapon fired:', event.weapon, 'by', event.shipId);
    });

    // Future: add AI-chat summarization hook, Puter KV flush trigger, etc.
}

// ─── Start ────────────────────────────────────────────────────
init();
