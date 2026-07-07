// VECTOR STRIKE: OMNI — Neural AI Behavior (Tier 3)
// Loaded dynamically into the Rust Wasm Rhai VM.
// Edit this file to tweak enemy behavior without recompiling.

// AI Personality Constants
const AGGRESSION = 0.85;
const EVASION_THRESHOLD = 0.3;
const GLITCH_COOLDOWN = 8.0;   // seconds

// === Core AI Update ===
// Note: last_glitch is passed in as a parameter because Rhai functions
// cannot mutate outer-scope variables. Returns the updated last_glitch value.

fn update_ai(ex, ey, ez, px, py, pz, e_health, e_glitch_ready, e_id, game_time, last_glitch) {
    let dist = vector_distance(ex, ey, ez, px, py, pz);
    let health_ratio = e_health / 100.0;

    // Predict player trajectory using inertial vectoring
    let predicted_pos = [px, py, pz];
    let new_last_glitch = last_glitch;

    // --- Behavior Selector ---

    if dist < 200.0 && e_glitch_ready && (game_time - last_glitch) > GLITCH_COOLDOWN {
        // GLITCH DRIVE: Quantum displacement -- emergency reposition
        trigger_glitch_drive(e_id);
        new_last_glitch = game_time;
        log_info("[AI] " + e_id + " -- GLITCH DISPLACEMENT ACTIVE");

    } else if health_ratio < EVASION_THRESHOLD {
        // EVASIVE: Low health -- disengage and reposition
        let retreat = normalize(ex - px, ey - py, ez - pz);
        align_heading(e_id, [ex + retreat[0] * 200.0, ey + retreat[1] * 200.0, ez + retreat[2] * 200.0]);
        apply_thrust(e_id, 25.0);
        log_info("[AI] " + e_id + " -- EVASIVE RETREAT");

    } else if dist < 400.0 {
        // ATTACK: Close range -- aggressive pursuit with evasive jinking
        let jink = sin(game_time * 4.0) * 30.0;
        let attack_pos = [
            predicted_pos[0] + jink,
            predicted_pos[1] + (random() - 0.5) * 20.0,
            predicted_pos[2]
        ];
        align_heading(e_id, attack_pos);
        apply_thrust(e_id, 18.0 * AGGRESSION);

        if dist < 300.0 {
            fire_vector_cannon(e_id, "plasma_bolt");
        }

    } else if dist < 800.0 {
        // PURSUIT: Medium range -- predict intercept point
        let intercept_time = dist / 60.0;
        let intercept_pos = [px, py, pz];
        align_heading(e_id, intercept_pos);
        apply_thrust(e_id, 22.0);

    } else {
        // PATROL: Long range -- close the gap with sweeping approach
        let sweep_offset = sin(game_time * 0.5) * 100.0;
        let patrol_pos = [px + sweep_offset, py + 50.0, pz];
        align_heading(e_id, patrol_pos);
        apply_thrust(e_id, 20.0);
    }

    // --- Active Defense ---
    if dist < 150.0 && health_ratio > 0.5 {
        // Barrel roll evasion at knife-fight range
        apply_torque(e_id, 0.0, 8.0, 0.0);
    }

    new_last_glitch  // return updated glitch time as last expression
}

// === Weapon Selection Logic ===

fn select_weapon(dist, energy) {
    if dist < 150.0 && energy > 30.0 {
        return ["plasma_bolt", 15.0];     // close-range burst
    } else if dist < 500.0 && energy > 15.0 {
        return ["ion_cannon", 8.0];        // medium-range sustained
    } else if energy > 50.0 {
        return ["rail_sniper", 30.0];      // long-range precision
    } else {
        return ["point_defense", 5.0];     // energy-efficient fallback
    }
}

// === Formation Flying (for squadrons) ===

fn formation_offset(index, total, game_time) {
    let angle = (index / total) * 2.0 * PI;
    let radius = 80.0 + sin(game_time * 0.3) * 20.0;
    [cos(angle) * radius, sin(angle) * radius * 0.5, 0.0]
}
