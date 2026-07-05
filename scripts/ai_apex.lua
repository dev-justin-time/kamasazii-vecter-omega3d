-- VECTOR STRIKE: OMNI — Neural AI Behavior (Tier 3)
-- Loaded dynamically into the Rust Wasm Lua VM.
-- Edit this file to tweak enemy behavior without recompiling.

-- AI Personality Constants
local AGGRESSION = 0.85
local EVASION_THRESHOLD = 0.3
local GLITCH_COOLDOWN = 8.0  -- seconds
local last_glitch_time = 0

-- ─── Core AI Update ───────────────────────────────────────────────────────────

function update_ai(enemy_ship, player_ship, game_time)
    local dist = vector_distance(enemy_ship.pos, player_ship.pos)
    local health_ratio = enemy_ship.health / 100.0

    -- Predict player trajectory using inertial vectoring
    local predicted_pos = {
        player_ship.pos[1] + (player_ship.velocity[1] * 0.5),
        player_ship.pos[2] + (player_ship.velocity[2] * 0.5),
        player_ship.pos[3] + (player_ship.velocity[3] * 0.5)
    }

    -- ─── Behavior Selector ────────────────────────────────────────────────

    if dist < 200.0 and enemy_ship.glitch_drive_ready and (game_time - last_glitch_time) > GLITCH_COOLDOWN then
        -- GLITCH DRIVE: Quantum displacement — emergency reposition
        trigger_glitch_drive(enemy_ship.id)
        last_glitch_time = game_time
        print("[AI] " .. enemy_ship.id .. " — GLITCH DISPLACEMENT ACTIVE")

    elseif health_ratio < EVASION_THRESHOLD then
        -- EVASIVE: Low health — disengage and reposition
        local retreat_dir = normalize({
            enemy_ship.pos[1] - player_ship.pos[1],
            enemy_ship.pos[2] - player_ship.pos[2],
            enemy_ship.pos[3] - player_ship.pos[3]
        })
        align_heading(enemy_ship.id, {
            enemy_ship.pos[1] + retreat_dir[1] * 200,
            enemy_ship.pos[2] + retreat_dir[2] * 200,
            enemy_ship.pos[3] + retreat_dir[3] * 200
        })
        apply_thrust(enemy_ship.id, 25.0)
        print("[AI] " .. enemy_ship.id .. " — EVASIVE RETREAT")

    elseif dist < 400.0 then
        -- ATTACK: Close range — aggressive pursuit with evasive jinking
        local jink = math.sin(game_time * 4.0) * 30
        local attack_pos = {
            predicted_pos[1] + jink,
            predicted_pos[2] + (math.random() - 0.5) * 20,
            predicted_pos[3]
        }
        align_heading(enemy_ship.id, attack_pos)
        apply_thrust(enemy_ship.id, 18.0 * AGGRESSION)

        if dist < 300.0 then
            fire_vector_cannon(enemy_ship.id, "plasma_bolt")
        end

    elseif dist < 800.0 then
        -- PURSUIT: Medium range — predict intercept point
        local intercept_time = dist / 60.0
        local intercept_pos = {
            predicted_pos[1] + player_ship.velocity[1] * intercept_time,
            predicted_pos[2] + player_ship.velocity[2] * intercept_time,
            predicted_pos[3] + player_ship.velocity[3] * intercept_time
        }
        align_heading(enemy_ship.id, intercept_pos)
        apply_thrust(enemy_ship.id, 22.0)

    else
        -- PATROL: Long range — close the gap with sweeping approach
        local sweep_offset = math.sin(game_time * 0.5) * 100
        local patrol_pos = {
            predicted_pos[1] + sweep_offset,
            predicted_pos[2] + 50,
            predicted_pos[3]
        }
        align_heading(enemy_ship.id, patrol_pos)
        apply_thrust(enemy_ship.id, 20.0)
    end

    -- ─── Active Defense ──────────────────────────────────────────────────
    if dist < 150.0 and health_ratio > 0.5 then
        -- Barrel roll evasion at knife-fight range
        apply_torque(enemy_ship.id, 0.0, 8.0, 0.0)
    end
end

-- ─── Weapon Selection Logic ────────────────────────────────────────────────────

function select_weapon(dist, enemy_energy)
    if dist < 150.0 and enemy_energy > 30 then
        return "plasma_bolt", 15.0  -- close-range burst
    elseif dist < 500.0 and enemy_energy > 15 then
        return "ion_cannon", 8.0    -- medium-range sustained
    elseif enemy_energy > 50 then
        return "rail_sniper", 30.0  -- long-range precision
    else
        return "point_defense", 5.0 -- energy-efficient fallback
    end
end

-- ─── Formation Flying (for squadrons) ──────────────────────────────────────────

function formation_offset(index, total, game_time)
    local angle = (index / total) * math.pi * 2
    local radius = 80.0 + math.sin(game_time * 0.3) * 20
    return {
        math.cos(angle) * radius,
        math.sin(angle) * radius * 0.5,
        0
    }
end

return {
    update_ai = update_ai,
    select_weapon = select_weapon,
    formation_offset = formation_offset
}
