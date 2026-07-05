-- VECTOR STRIKE: OMNI — Weapon Systems
-- Weapon definitions loaded by the Rust engine at runtime.

WEAPONS = {
    plasma_bolt = {
        display_name = "Plasma Bolt",
        damage = 12.0,
        speed = 120.0,
        cooldown = 0.3,
        energy_cost = 15.0,
        heat_generation = 8.0,
        range = 400.0,
        color = { 0.2, 0.8, 1.0 },  -- cyan
        particle_count = 5,
        explosion_radius = 8.0,
        sound = "plasma_fire"
    },
    ion_cannon = {
        display_name = "Ion Cannon",
        damage = 8.0,
        speed = 90.0,
        cooldown = 0.15,
        energy_cost = 8.0,
        heat_generation = 4.0,
        range = 500.0,
        color = { 0.6, 0.2, 1.0 },  -- violet
        particle_count = 3,
        explosion_radius = 5.0,
        sound = "ion_fire"
    },
    rail_sniper = {
        display_name = "Rail Sniper",
        damage = 35.0,
        speed = 200.0,
        cooldown = 1.2,
        energy_cost = 30.0,
        heat_generation = 25.0,
        range = 800.0,
        color = { 1.0, 0.4, 0.0 },  -- orange
        particle_count = 8,
        explosion_radius = 12.0,
        sound = "rail_fire"
    },
    point_defense = {
        display_name = "Point Defense",
        damage = 4.0,
        speed = 60.0,
        cooldown = 0.08,
        energy_cost = 3.0,
        heat_generation = 2.0,
        range = 200.0,
        color = { 0.0, 1.0, 0.4 },  -- green
        particle_count = 2,
        explosion_radius = 3.0,
        sound = "pd_fire"
    },
    missile = {
        display_name = "Heatseeker",
        damage = 50.0,
        speed = 80.0,
        cooldown = 3.0,
        energy_cost = 40.0,
        heat_generation = 30.0,
        range = 600.0,
        color = { 1.0, 0.1, 0.1 },  -- red
        particle_count = 12,
        explosion_radius = 20.0,
        sound = "missile_launch",
        homing = true,
        turn_rate = 2.0
    }
}

-- Overheat system
OVERHEAT = {
    max_heat = 100.0,
    cooldown_rate = 15.0,    -- per second
    penalty_threshold = 80.0, -- accuracy penalty above this
    shutdown_threshold = 100.0 -- weapon lock at this
}

-- Returns the effective weapon based on current heat level
function get_available_weapons(current_heat)
    local available = {}
    for name, weapon in pairs(WEAPONS) do
        local effective_heat = current_heat + weapon.heat_generation
        if effective_heat < OVERHEAT.shutdown_threshold then
            table.insert(available, name)
        end
    end
    return available
end
