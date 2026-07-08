// ─── Weapon Definitions ────────────────────────────────────────
// Mirrors the weapon data that would come from engine scripts.
// The order here defines the cycle order (Tab / number keys).

export const WEAPON_DEFS = Object.freeze({
    plasma_bolt: Object.freeze({
        display_name: 'Plasma Bolt',
        damage: 12, speed: 120, cooldown: 0.3, energy_cost: 15, heat_generation: 8,
        range: 400, color: [0.2, 0.8, 1.0], sound: 'plasma_fire', homing: false,
    }),
    ion_cannon: Object.freeze({
        display_name: 'Ion Cannon',
        damage: 8, speed: 90, cooldown: 0.15, energy_cost: 8, heat_generation: 4,
        range: 500, color: [0.6, 0.2, 1.0], sound: 'ion_fire', homing: false,
    }),
    rail_sniper: Object.freeze({
        display_name: 'Rail Sniper',
        damage: 35, speed: 200, cooldown: 1.2, energy_cost: 30, heat_generation: 25,
        range: 800, color: [1.0, 0.4, 0.0], sound: 'rail_fire', homing: false,
    }),
    point_defense: Object.freeze({
        display_name: 'Point Defense',
        damage: 4, speed: 60, cooldown: 0.08, energy_cost: 3, heat_generation: 2,
        range: 200, color: [0.0, 1.0, 0.4], sound: 'pd_fire', homing: false,
    }),
    missile: Object.freeze({
        display_name: 'Heatseeker',
        damage: 50, speed: 80, cooldown: 3.0, energy_cost: 40, heat_generation: 30,
        range: 600, color: [1.0, 0.1, 0.1], sound: 'missile_launch', homing: true,
        turn_rate: 2.0,
    }),
});

// Ordered list for cycling — maintains the same order as weapons.rhai
export const WEAPON_ORDER = Object.freeze(Object.keys(WEAPON_DEFS));
