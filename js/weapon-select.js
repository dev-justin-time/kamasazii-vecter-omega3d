// ─── Weapon Selection ───────────────────────────────────────────
// Cycling, index selection, and engine sync live here alongside
// the WEAPON_DEFS / WEAPON_ORDER from weapons.js (re-exported).

import { elements } from './dom.js';
import { state } from './state.js';
import { WEAPON_DEFS, WEAPON_ORDER } from './weapons.js';

// ── Deduped console warn for weapon sync errors (60s window) ───────────────
let _lastWeaponWarnAt = 0;
function _dedupedWarn(label, ...args) {
  if (Date.now() - _lastWeaponWarnAt > 60000) {
    _lastWeaponWarnAt = Date.now();
    console.warn(label, ...args);
  }
}

export { WEAPON_DEFS, WEAPON_ORDER };

export function cycleWeapon(direction) {
    const len = state.availableWeapons.length;
    if (len === 0) return;
    const idx = (state.weaponIndex + direction + len) % len;
    selectWeaponByIndex(idx);
}

export function selectWeaponByIndex(idx) {
    if (idx < 0 || idx >= state.availableWeapons.length) return;
    state.weaponIndex = idx;
    state.weapon = state.availableWeapons[idx];
    const def = WEAPON_DEFS[state.weapon];
    if (def) {
        elements.weaponName.textContent = def.display_name.toUpperCase();
        elements.weaponStatus.textContent = 'READY';
    }
}

/**
 * Load weapon names from the Wasm engine (if available) and merge
 * into our available weapons list.  Bridges weapons.rhai data loaded
 * into the Rust engine with the JS weapon system.
 */
export function syncWeaponsFromEngine(engine) {
    if (!engine) return;
    try {
        const raw = engine.get_weapon_names();
        const engineWeapons = JSON.parse(raw);
        if (Array.isArray(engineWeapons) && engineWeapons.length > 0) {
            const merged = [];
            for (const name of engineWeapons) {
                if (WEAPON_DEFS[name]) merged.push(name);
                else _dedupedWarn('[WEAPON] Unknown weapon from engine:', name);
            }
            if (merged.length > 0) {
                state.availableWeapons = merged;
                if (!merged.includes(state.weapon)) {
                    state.weaponIndex = 0;
                    state.weapon = merged[0];
                } else {
                    state.weaponIndex = merged.indexOf(state.weapon);
                }
                console.log('[WEAPON] Synced ' + merged.length + ' weapons from engine:', merged.join(', '));
            }
        }
    } catch (e) {
        _dedupedWarn('[WEAPON] Failed to sync from engine:', e);
    }
}
