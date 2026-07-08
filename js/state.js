// ─── Game State ──────────────────────────────────────────────────
// Single mutable state object shared across all modules.

import { WEAPON_ORDER } from './weapons.js';

export const state = {
    fps: 0,
    frameCount: 0,
    lastFpsUpdate: performance.now(),
    score: 0,
    health: 100,
    energy: 100,
    heat: 0,
    glitchReady: true,
    weapon: 'plasma_bolt',
    running: false,
    engine: null,           // Wasm GameEngine instance (may be null)
    ws: null,
    puterReady: false,
    // Weapon system state
    weaponIndex: 0,
    weaponCooldowns: {},    // weapon key -> remaining cooldown seconds
    availableWeapons: [...WEAPON_ORDER],
    // Game mode: 'pvai' or 'pvp'
    gameMode: 'pvai',
    // Player 2 state (PvP)
    p2: { health: 100, energy: 100, glitchReady: true },
    // Render function — set by renderer.js after WebGL init
    render: null,
};

// Initialize cooldown timers for all weapons
for (const key of WEAPON_ORDER) {
    state.weaponCooldowns[key] = 0;
}
