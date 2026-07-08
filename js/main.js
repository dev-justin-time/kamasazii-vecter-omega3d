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

// ─── Boot ─────────────────────────────────────────────────────

async function loadWasmEngine() {
    try {
        const wasm = await import('../pkg/vector_strike_core.js');
        await wasm.default();
        const engine = new wasm.GameEngine();
        elements.engineVer.textContent = 'v' + (engine.version ? engine.version() : '0.1.0');
        return engine;
    } catch (e) {
        console.error('[WASM] Failed to load engine:', e);
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
        syncWeaponsFromEngine(engine);
        startRhaiHotReload(engine);
    }

    // Restore persisted loadout
    const saved = await loadLoadout();
    if (saved) {
        if (saved.player_1 && SHIPS.available.some(s => s.key === saved.player_1)) {
            SHIPS.assignments.player_1 = saved.player_1;
            if (elements.loadoutNameP1) {
                const entry = SHIPS.available.find(s => s.key === saved.player_1);
                if (entry) { elements.loadoutNameP1.textContent = entry.name; elements.loadoutDescP1.textContent = entry.desc; }
            }
        }
        if (saved.player_2 && SHIPS.available.some(s => s.key === saved.player_2)) {
            SHIPS.assignments.player_2 = saved.player_2;
            if (elements.loadoutNameP2) {
                const entry = SHIPS.available.find(s => s.key === saved.player_2);
                if (entry) { elements.loadoutNameP2.textContent = entry.name; elements.loadoutDescP2.textContent = entry.desc; }
            }
        }
        if (saved.mode) setGameMode(saved.mode);
    }

    // Done loading
    elements.loading.style.display = 'none';
    elements.enterBtn.disabled = false;
    elements.enterBtn.textContent = 'LAUNCH MISSION';

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
        } catch (_) {}
    }

    // ── Weapon cooldowns ──────────────────────────────────────
    for (const key of WEAPON_ORDER) {
        if (state.weaponCooldowns[key] > 0) {
            state.weaponCooldowns[key] = Math.max(0, state.weaponCooldowns[key] - dt);
        }
    }

    // ── Fire weapon ───────────────────────────────────────────
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

    // ── Heat dissipation ──────────────────────────────────────
    state.heat = Math.max(0, state.heat - 15 * dt);

    // ── Update HUD ────────────────────────────────────────────
    updateHUD();

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
    if (elements.modePvai) elements.modePvai.classList.toggle('active', mode === 'pvai');
    if (elements.modePvp) elements.modePvp.classList.toggle('active', mode === 'pvp');
    if (elements.pvpStatus) elements.pvpStatus.classList.toggle('hidden', mode !== 'pvp');
    if (elements.loadoutSlot2Label) elements.loadoutSlot2Label.textContent = mode === 'pvp' ? 'P2' : 'AI';
    if (mode === 'pvp') {
        SHIPS.assignments.player_2 = SHIPS.available[loadoutIdx.player_2]?.key || 'corsair_plane';
    } else {
        SHIPS.assignments.player_2 = 'corsair_plane';
    }
    saveLoadout({ player_1: SHIPS.assignments.player_1, player_2: SHIPS.assignments.player_2, mode });
}

// ─── Event Listeners ──────────────────────────────────────────

elements.enterBtn.addEventListener('click', () => {
    state.running = true;
    elements.briefing.style.display = 'none';
    if (state.engine) {
        const mode = state.gameMode === 'pvp' ? 'pvp' : 'pvai';
        state.engine.reset_ships(mode);
        // Analytics: track ship spawns (WASM reset_ships is synchronous)
        try {
            const ships = JSON.parse(state.engine.get_ship_positions());
            for (const s of ships) {
                analytics.trackShipSpawn(s.id, SHIPS.assignments[s.id]);
            }
            analytics.trackMissionStart(mode);
        } catch (_) {}
    }
    connectWebSocket();
});

document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = btn.dataset.mode;
        if (mode) setGameMode(mode);
    });
});

// ─── Resize ───────────────────────────────────────────────────
window.addEventListener('resize', () => {
    if (canvas && gl) {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        gl.viewport(0, 0, canvas.width, canvas.height);
    }
});

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
        console.log('[ANALYTICS] Ship spawned:', event.shipId, event.shipModel);
    });

    analytics.on(EventType.WEAPON_FIRE, (event) => {
        console.log('[ANALYTICS] Weapon fired:', event.weapon, 'by', event.shipId);
    });

    // Future: add AI-chat summarization hook, Puter KV flush trigger, etc.
}

// ─── Start ────────────────────────────────────────────────────
init();
