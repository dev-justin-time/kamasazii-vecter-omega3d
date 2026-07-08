// ─── HUD Update ──────────────────────────────────────────────
// Single function that reads state and writes DOM.  Called from
// the game loop (fixedUpdate) and from network state sync.

import { elements } from './dom.js';
import { state } from './state.js';
import { WEAPON_DEFS } from './weapons.js';

export function updateHUD() {
    elements.healthVal.textContent = Math.round(state.health);
    elements.healthBar.style.width = Math.max(0, state.health) + '%';
    elements.energyVal.textContent = Math.round(state.energy);
    elements.energyBar.style.width = Math.max(0, state.energy) + '%';
    elements.heatVal.textContent = Math.round(state.heat);
    elements.heatBar.style.width = Math.min(100, state.heat) + '%';
    elements.scoreVal.textContent = state.score;
    elements.glitchStatus.textContent = state.glitchReady ? 'READY' : 'COOLDOWN';
    elements.glitchStatus.style.color = state.glitchReady
        ? 'var(--neon-green)' : 'var(--text-dim)';

    // Weapon status line
    const def = WEAPON_DEFS[state.weapon];
    if (def) {
        const cd = state.weaponCooldowns[state.weapon] || 0;
        const heatOk = state.heat + def.heat_generation < 100;
        const energyOk = state.energy >= def.energy_cost;
        if (cd > 0) {
            elements.weaponStatus.textContent = 'COOLDOWN ' + cd.toFixed(1) + 's';
            elements.weaponStatus.style.color = 'var(--text-dim)';
        } else if (!energyOk) {
            elements.weaponStatus.textContent = 'LOW ENERGY';
            elements.weaponStatus.style.color = 'var(--neon-orange)';
        } else if (!heatOk) {
            elements.weaponStatus.textContent = 'OVERHEAT';
            elements.weaponStatus.style.color = 'var(--neon-red)';
        } else {
            const afk = state.availableWeapons.length;
            const aidx = state.weaponIndex + 1;
            elements.weaponStatus.textContent = 'READY  [' + aidx + '/' + afk + ']';
            elements.weaponStatus.style.color = '';
        }
    }
}
