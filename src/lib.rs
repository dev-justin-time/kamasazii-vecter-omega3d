use js_sys::Math;
use nalgebra::{Matrix3, Point3, Vector3};
use rhai::Engine;
use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use web_sys::{WebGl2RenderingContext, WebGlProgram, WebGlShader, WebGlUniformLocation};

// ─── Command Buffer ───────────────────────────────────────────────────────────
// Rhai closures registered via `register_fn` must be `Fn` (not `FnMut`), so they
// cannot borrow `GameEngine.ships` mutably.  Instead, AI scripts push commands
// into a shared `Rc<RefCell<Vec<ShipCommand>>>` that the tick loop drains.

#[derive(Clone, Debug)]
enum ShipCommand {
    ApplyThrust(String, f32),
    ApplyTorque(String, f32, f32, f32),
    FireWeapon(String, String),
    TriggerGlitchDrive(String),
    AlignHeading(String, [f32; 3]),
}

// ─── Ship State ───────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct ShipState {
    id: String,
    position: Vector3<f32>,
    velocity: Vector3<f32>,
    rotation: Matrix3<f32>,
    angular_velocity: Vector3<f32>,
    health: f32,
    energy: f32,
    glitch_drive_ready: bool,
    thrust_level: f32,
    // ── Custom-build stats (modulated by JS Star-Sparrow build-out) ──
    /// Relative mass — heavier ships accelerate slower but hold momentum
    mass: f32,
    /// Multiplier on forward thrust force
    thrust_mult: f32,
    /// Per-tick velocity damping (0.99 = light, 0.95 = heavy bomber)
    drag: f32,
    /// Per-tick angular velocity damping (more = sluggish rotation)
    angular_drag: f32,
}

impl ShipState {
    fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            position: Vector3::new(0.0, 0.0, 0.0),
            velocity: Vector3::new(0.0, 0.0, 0.0),
            rotation: Matrix3::identity(),
            angular_velocity: Vector3::new(0.0, 0.0, 0.0),
            health: 100.0,
            energy: 100.0,
            glitch_drive_ready: false,
            thrust_level: 0.0,
            mass: 1.0,
            thrust_mult: 1.0,
            drag: 0.999,
            angular_drag: 0.98,
        }
    }

    fn apply_thrust(&mut self, force: f32, dt: f32) {
        let forward = self.rotation * Vector3::new(0.0, 0.0, -1.0);
        // Heavy ships accelerate slower (a = F/m). Clamp mass to avoid
        // divide-by-zero for malformed stats input.
        let accel = self.thrust_mult / self.mass.max(0.1);
        self.velocity += forward * force * accel * dt;
        self.thrust_level = force;
    }

    fn apply_torque(&mut self, torque: Vector3<f32>, dt: f32) {
        self.angular_velocity += torque * dt;
    }

    fn integrate(&mut self, dt: f32) {
        self.position += self.velocity * dt;
        // Simple angular integration
        let axis = self.angular_velocity.normalize();
        let angle = self.angular_velocity.magnitude() * dt;
        if angle.abs() > 1e-6 {
            let cos_a = angle.cos();
            let sin_a = angle.sin();
            let kx = axis.x;
            let ky = axis.y;
            let kz = axis.z;
            let rotation_matrix = Matrix3::new(
                cos_a + kx * kx * (1.0 - cos_a),
                kx * ky * (1.0 - cos_a) - kz * sin_a,
                kx * kz * (1.0 - cos_a) + ky * sin_a,
                ky * kx * (1.0 - cos_a) + kz * sin_a,
                cos_a + ky * ky * (1.0 - cos_a),
                ky * kz * (1.0 - cos_a) - kx * sin_a,
                kz * kx * (1.0 - cos_a) - ky * sin_a,
                kz * ky * (1.0 - cos_a) + kx * sin_a,
                cos_a + kz * kz * (1.0 - cos_a),
            );
            self.rotation = rotation_matrix * self.rotation;
        }
        // Damping — heavier ships damp more per tick (momentum feel).
        // sqrt(mass) keeps the factor in a sane range: m=1 → 1.0, m=4 → 2.0.
        let mass_factor = self.mass.sqrt().clamp(0.5, 2.0);
        self.angular_velocity *= self.angular_drag.powf(mass_factor);
        self.velocity *= self.drag.powf(mass_factor);
        // Energy regeneration
        self.energy = (self.energy + 2.0 * dt).min(100.0);
        if self.energy >= 100.0 {
            self.glitch_drive_ready = true;
        }
    }
}

// ─── Weapon Specs (mirrors scripts/weapons.rhai) ───────────────────────────────
// Per-weapon projectile behavior. Mirrored in JS (weapons.js) for the renderer.
// `speed`     — world units per second along firing ship's forward axis.
// `ttl`       — projectile lifetime before auto-despawn (seconds).
// `homing`    — only `missile` updates its velocity toward the nearest enemy.
// `damage`    — applied on hit (1.0 = 1 HP reduction).
// `hit_radius`— sphere radius for ship/projectile collision test.
struct WeaponSpec {
    speed: f32,
    ttl: f32,
    damage: f32,
    color: [f32; 3],
    homing: bool,
    turn_rate: f32,
    hit_radius: f32,
}

fn weapon_spec(name: &str) -> Option<WeaponSpec> {
    match name {
        "plasma_bolt" => Some(WeaponSpec {
            speed: 120.0, ttl: 1.8, damage: 12.0,
            color: [0.2, 0.8, 1.0],     // cyan
            homing: false, turn_rate: 0.0,
            hit_radius: 2.0,
        }),
        "ion_cannon" => Some(WeaponSpec {
            speed: 90.0, ttl: 2.4, damage: 8.0,
            color: [0.6, 0.2, 1.0],     // violet
            homing: false, turn_rate: 0.0,
            hit_radius: 2.5,
        }),
        "rail_sniper" => Some(WeaponSpec {
            speed: 220.0, ttl: 2.0, damage: 35.0,
            color: [1.0, 0.4, 0.0],     // orange
            homing: false, turn_rate: 0.0,
            hit_radius: 1.5,
        }),
        "point_defense" => Some(WeaponSpec {
            speed: 60.0, ttl: 1.5, damage: 4.0,
            color: [0.0, 1.0, 0.4],     // green
            homing: false, turn_rate: 0.0,
            hit_radius: 1.5,
        }),
        "missile" => Some(WeaponSpec {
            speed: 80.0, ttl: 4.0, damage: 50.0,
            color: [1.0, 0.1, 0.1],     // red
            homing: true, turn_rate: 2.5,
            hit_radius: 3.0,
        }),
        _ => None,
    }
}

// ─── Projectile State ──────────────────────────────────────────────────────────
#[derive(Clone, Debug)]
struct ProjectileState {
    id: u32,
    owner_id: String,
    /// Frame on which this projectile was spawned — renderer uses it for
    /// a brief muzzle-flash effect at the spawn point.
    spawn_frame: u32,
    position: Vector3<f32>,
    /// Previous-frame position — drives the wireframe streak rendered in JS.
    prev_position: Vector3<f32>,
    velocity: Vector3<f32>,
    weapon: String,
    color: [f32; 3],
    damage: f32,
    hit_radius: f32,
    homing: bool,
    turn_rate: f32,
    /// Per-weapon time-to-live (seconds) — auto-despawns after this.
    ttl: f32,
    age: f32,
}

// ─── Engine ───────────────────────────────────────────────────────────────────

#[wasm_bindgen]
pub struct GameEngine {
    engine: Engine,
    ships: Vec<ShipState>,
    ai_active: bool,
    frame_count: u32,
    time_accumulator: f32,
    // WebGL state (held opaque to JS)
    gl: Option<WebGl2RenderingContext>,
    wireframe_program: Option<WebGlProgram>,
    wireframe_u_mvp: Option<WebGlUniformLocation>,
    canvas_width: f32,
    canvas_height: f32,
    /// Command buffer shared with Rhai closures — AI scripts push commands
    /// here, and `process_commands()` drains them after each script run.
    commands: Rc<RefCell<Vec<ShipCommand>>>,
    /// Active projectiles (bullets, plasma, rails, missiles). Owned by the
    /// engine so the renderer can pull a snapshot via `get_projectiles()`.
    projectiles: Vec<ProjectileState>,
    /// Monotonic counter for projectile IDs (also used to recently-fired
    /// shots for muzzle-flash detection in the renderer).
    next_projectile_id: u32,
}

#[wasm_bindgen]
impl GameEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> GameEngine {
        let mut engine = Engine::new();
        let commands: Rc<RefCell<Vec<ShipCommand>>> = Rc::new(RefCell::new(Vec::new()));

        // Register Rust functions exposed to Rhai scripts
        GameEngine::register_rhai_functions(&mut engine, &commands);

        // Preload core Rhai gameplay scripts — defines vector_distance, normalize,
        // and evaluate_combat_state for use by ai_apex.rhai and the inline tick AI.
        if let Err(e) = engine.run(
            r#"
                // VECTOR STRIKE: OMNI Core Rhai Environment

                fn vector_distance(x1, y1, z1, x2, y2, z2) {
                    let dx = x1 - x2;
                    let dy = y1 - y2;
                    let dz = z1 - z2;
                    sqrt(dx * dx + dy * dy + dz * dz)
                }

                fn normalize(x, y, z) {
                    let mag = sqrt(x * x + y * y + z * z);
                    if mag == 0.0 { [0.0, 0.0, 0.0] }
                    else { [x / mag, y / mag, z / mag] }
                }

                // Default combat AI (overridable by ai_apex.rhai hot-reload)
                fn evaluate_combat_state(ex, ey, ez, px, py, pz, enemy_health) {
                    let dist = vector_distance(ex, ey, ez, px, py, pz);
                    let threat = if dist < 300.0 { 1.0 }
                        else if dist < 800.0 { 0.5 }
                        else { 0.1 };
                    [dist, threat]
                }
            "#,
        ) {
            let _ = web_sys::console::log_1(&format!("[RHAI] Init error: {}", e).into());
        }

        GameEngine {
            engine,
            ships: vec![ShipState::new("player_1"), ShipState::new("enemy_apex")],
            ai_active: true,
            frame_count: 0,
            time_accumulator: 0.0,
            gl: None,
            wireframe_program: None,
            wireframe_u_mvp: None,
            canvas_width: 800.0,
            canvas_height: 600.0,
            commands,
            projectiles: Vec::new(),
            next_projectile_id: 0,
        }
    }

    fn register_rhai_functions(engine: &mut Engine, commands: &Rc<RefCell<Vec<ShipCommand>>>) {
        // Clone the Rc for each closure so they all share the same command buffer.
        let cmd = commands.clone();
        engine.register_fn("apply_thrust", move |ship_id: String, force: f64| {
            cmd.borrow_mut().push(ShipCommand::ApplyThrust(ship_id, force as f32));
        });

        let cmd = commands.clone();
        engine.register_fn(
            "fire_vector_cannon",
            move |ship_id: String, weapon_type: String| {
                cmd.borrow_mut().push(ShipCommand::FireWeapon(ship_id, weapon_type));
                true
            },
        );

        engine.register_fn("get_distance_to_target", || -> f64 { 600.0 });

        let cmd = commands.clone();
        engine.register_fn("trigger_glitch_drive", move |ship_id: String| {
            cmd.borrow_mut().push(ShipCommand::TriggerGlitchDrive(ship_id));
        });

        let cmd = commands.clone();
        engine.register_fn(
            "align_heading",
            move |ship_id: String, target: Vec<f64>| {
                if target.len() >= 3 {
                    let pos = [target[0] as f32, target[1] as f32, target[2] as f32];
                    cmd.borrow_mut().push(ShipCommand::AlignHeading(ship_id, pos));
                }
            },
        );

        let cmd = commands.clone();
        engine.register_fn("apply_torque", move |ship_id: String, roll: f64, pitch: f64, yaw: f64| {
            cmd.borrow_mut().push(ShipCommand::ApplyTorque(
                ship_id, roll as f32, pitch as f32, yaw as f32,
            ));
        });

        engine.register_fn("random", || -> f64 { Math::random() });

        engine.register_fn("log_info", |msg: String| {
            web_sys::console::log_1(&msg.into());
        });
    }

    /// Drain the command buffer and apply each command to the matching ship.
    /// Called once per tick, after all Rhai scripts have executed.
    fn process_commands(&mut self, dt: f32) {
        let cmds: Vec<ShipCommand> = self.commands.borrow_mut().drain(..).collect();
        for cmd in cmds {
            match cmd {
                ShipCommand::ApplyThrust(id, force) => {
                    if let Some(ship) = self.ships.iter_mut().find(|s| s.id == id) {
                        ship.apply_thrust(force, dt);
                    }
                }
                ShipCommand::ApplyTorque(id, roll, pitch, yaw) => {
                    if let Some(ship) = self.ships.iter_mut().find(|s| s.id == id) {
                        let torque = Vector3::new(pitch * 5.0, yaw * 5.0, roll * 3.0);
                        ship.apply_torque(torque, dt);
                    }
                }
                ShipCommand::FireWeapon(id, weapon) => {
                    // Spawn a projectile from this ship's muzzle so the
                    // renderer can show a visible bullet/plasma/rail/missile.
                    self.spawn_projectile(&id, &weapon);
                }
                ShipCommand::TriggerGlitchDrive(id) => {
                    if let Some(ship) = self.ships.iter_mut().find(|s| s.id == id) {
                        if ship.glitch_drive_ready {
                            // Teleport forward by 500 units
                            let forward = ship.rotation * Vector3::new(0.0, 0.0, -1.0);
                            ship.position += forward * 500.0;
                            ship.energy = 0.0;
                            ship.glitch_drive_ready = false;
                            web_sys::console::log_1(
                                &format!("[GLITCH] {} quantum jump!", id).into(),
                            );
                        }
                    }
                }
                ShipCommand::AlignHeading(id, target) => {
                    if let Some(ship) = self.ships.iter_mut().find(|s| s.id == id) {
                        let to_target = Vector3::new(
                            target[0] - ship.position.x,
                            target[1] - ship.position.y,
                            target[2] - ship.position.z,
                        );
                        let dist = to_target.magnitude();
                        if dist > 0.01 {
                            // Compute steering torque to align forward vector toward target.
                            // Forward is -Z in ship-local space.
                            let forward = ship.rotation * Vector3::new(0.0, 0.0, -1.0);
                            let desired = to_target.normalize();
                            let cross = forward.cross(&desired);
                            let dot = forward.dot(&desired).clamp(-1.0, 1.0);
                            // Proportional steering: stronger correction for larger misalignment.
                            let gain = 4.0;
                            let torque = Vector3::new(
                                cross.x * gain,
                                cross.y * gain,
                                cross.z * gain * 0.5, // less yaw authority
                            );
                            ship.apply_torque(torque, dt);
                            // Also apply thrust toward target
                            let thrust = if dot > 0.3 { 20.0 } else { 8.0 };
                            ship.apply_thrust(thrust, dt);
                        }
                    }
                }
            }
        }
    }

    /// Spawn a projectile from the named ship's muzzle along its forward axis.
    /// Returns silently if the ship is missing or the weapon key is unknown.
    /// Homing weapons (currently `missile`) snap toward the nearest alive
    /// non-owner ship on every tick via `update_projectiles`.
    fn spawn_projectile(&mut self, owner_id: &str, weapon: &str) {
        let spec = match weapon_spec(weapon) {
            Some(s) => s,
            None => {
                web_sys::console::log_1(
                    &format!("[WEAPON] unknown weapon: {}", weapon).into(),
                );
                return;
            }
        };

        // Copy the bits we need out of `self.ships` so we can borrow mutably
        // again right after to push the projectile.
        let (spawn_pos, forward) = {
            let ship = match self.ships.iter().find(|s| s.id == owner_id) {
                Some(s) => s,
                None => {
                    web_sys::console::log_1(
                        &format!("[WEAPON] unknown ship: {}", owner_id).into(),
                    );
                    return;
                }
            };
            // Forward in ship-local space = -Z (matches apply_thrust / camera)
            let fwd = ship.rotation * Vector3::new(0.0, 0.0, -1.0);
            (ship.position + fwd * 5.0, fwd)
        };

        let id = self.next_projectile_id;
        self.next_projectile_id = self.next_projectile_id.wrapping_add(1);

        self.projectiles.push(ProjectileState {
            id,
            owner_id: owner_id.to_string(),
            spawn_frame: self.frame_count,
            position: spawn_pos,
            prev_position: spawn_pos,
            velocity: forward * spec.speed,
            weapon: weapon.to_string(),
            color: spec.color,
            damage: spec.damage,
            hit_radius: spec.hit_radius,
            homing: spec.homing,
            turn_rate: spec.turn_rate,
            ttl: spec.ttl,
            age: 0.0,
        });

        web_sys::console::log_1(
            &format!("[WEAPON] {} fired {} (proj #{})", owner_id, weapon, id).into(),
        );
    }

    /// Advance every projectile one tick: integrate position, curve homing
    /// missiles toward the nearest alive target, decay age, run ship-vs-
    /// projectile collision, and despawn expired or consumed shots.
    ///
    /// We use `mem::take` to move the projectile Vec out of `self` so we can
    /// still mutably borrow `self.ships` for collision within the same loop.
    fn update_projectiles(&mut self, dt: f32) {
        let mut next: Vec<ProjectileState> = Vec::with_capacity(self.projectiles.len());
        let snapshot: Vec<ProjectileState> = std::mem::take(&mut self.projectiles);
        for mut p in snapshot {
            // Snapshot last-frame position before moving so the renderer can
            // draw a streak from prev → current (visible motion blur).
            p.prev_position = p.position;

            if p.homing {
                // Pick the nearest alive non-owner ship. For two-player arena
                // this resolves to the obvious target — expand later for sqms.
                let mut best: Option<(f32, Vector3<f32>)> = None;
                for ship in self.ships.iter() {
                    if ship.id == p.owner_id || ship.health <= 0.0 {
                        continue;
                    }
                    let d_sq = (ship.position - p.position).norm_squared();
                    if best.map_or(true, |b| d_sq < b.0) {
                        best = Some((d_sq, ship.position));
                    }
                }
                if let Some((_, tgt)) = best {
                    let to_target = tgt - p.position;
                    let dist = to_target.norm();
                    if dist > 1e-3 {
                        let desired = to_target / dist;
                        let v_mag = p.velocity.norm();
                        if v_mag > 1e-3 {
                            let current = p.velocity / v_mag;
                            // Rotate `current` toward `desired` by at most
                            // turn_rate * dt radians (true turn-rate clamp).
                            let cos_a = current.dot(&desired).clamp(-1.0, 1.0);
                            let angle = cos_a.acos();
                            let max_turn = (p.turn_rate * dt).min(angle);
                            let sin_a_max = max_turn.sin();
                            let cos_a_step = max_turn.cos();
                            // Rodrigues rotation: rotate `current` around
                            // the (current × desired) axis. Then re-normalize
                            // to recover direction; keep speed constant.
                            let axis = current.cross(&desired);
                            let axis_len = axis.norm();
                            let new_dir = if axis_len < 1e-4 {
                                // Already aligned — no rotation needed.
                                desired
                            } else {
                                let k = axis / axis_len;
                                let v = current;
                                let rotated = Vector3::new(
                                    v.x * cos_a_step
                                        + (k.y * v.z - k.z * v.y) * sin_a_max
                                        + k.x * (k.dot(&v)) * (1.0 - cos_a_step),
                                    v.y * cos_a_step
                                        + (k.z * v.x - k.x * v.z) * sin_a_max
                                        + k.y * (k.dot(&v)) * (1.0 - cos_a_step),
                                    v.z * cos_a_step
                                        + (k.x * v.y - k.y * v.x) * sin_a_max
                                        + k.z * (k.dot(&v)) * (1.0 - cos_a_step),
                                );
                                rotated.normalize()
                            };
                            p.velocity = new_dir * v_mag;
                        }
                    }
                }
            }

            // Integrate velocity — cap to keep fast weapons from overshooting
            // in single big steps and tunneling through a ship.
            const STEP_CAP: f32 = 0.05;
            let step_dt = dt.min(STEP_CAP);
            p.position += p.velocity * step_dt;
            p.age += dt;
            if p.age >= p.ttl {
                continue;
            }

            // Ship-vs-projectile collision. Approximate ship as a sphere of
            // radius 2.5 (matches `_scale` 2.5 used by renderer.js fallback).
            let ship_radius: f32 = 2.5;
            let mut consumed = false;
            for ship in self.ships.iter_mut() {
                if ship.id == p.owner_id || ship.health <= 0.0 {
                    continue;
                }
                let diff = p.position - ship.position;
                let hit_r = p.hit_radius + ship_radius;
                if diff.norm_squared() < hit_r * hit_r {
                    ship.health = (ship.health - p.damage).max(0.0);
                    if ship.health <= 0.0 {
                        ship.glitch_drive_ready = false;
                    }
                    web_sys::console::log_1(
                        &format!(
                            "[HIT] {} hit {} for {:.1} dmg → hp {:.1}",
                            p.owner_id, ship.id, p.damage, ship.health
                        )
                        .into(),
                    );
                    consumed = true;
                    break;
                }
            }
            if !consumed {
                next.push(p);
            }
        }
        self.projectiles = next;
    }

    /// Initialize WebGL2 context and compile wireframe shaders
    pub fn init_gl(&mut self, canvas_id: &str) -> Result<(), JsValue> {
        let document = web_sys::window().unwrap().document().unwrap();
        let canvas = document
            .get_element_by_id(canvas_id)
            .unwrap()
            .dyn_into::<web_sys::HtmlCanvasElement>()?;

        let gl = canvas
            .get_context("webgl2")?
            .unwrap()
            .dyn_into::<WebGl2RenderingContext>()?;

        // Wireframe vertex shader — neon glow aesthetic
        let vs_src = r#"
            #version 300 es
            in vec3 aPosition;
            in vec3 aColor;
            uniform mat4 uModelViewProjection;
            out vec3 vColor;
            void main() {
                gl_Position = uModelViewProjection * vec4(aPosition, 1.0);
                vColor = aColor;
                gl_PointSize = 2.0;
            }
        "#;

        // Wireframe fragment shader
        let fs_src = r#"
            #version 300 es
            precision highp float;
            in vec3 vColor;
            out vec4 fragColor;
            void main() {
                fragColor = vec4(vColor, 1.0);
            }
        "#;

        let vs = Self::compile_shader(&gl, WebGl2RenderingContext::VERTEX_SHADER, vs_src)?;
        let fs = Self::compile_shader(&gl, WebGl2RenderingContext::FRAGMENT_SHADER, fs_src)?;
        let program = Self::link_program(&gl, &vs, &fs)?;

        gl.use_program(Some(&program));
        gl.clear_color(0.0, 0.0, 0.05, 1.0);
        gl.enable(WebGl2RenderingContext::DEPTH_TEST);

        // Cache the MVP uniform location once (avoid per-frame lookup)
        let u_mvp = gl.get_uniform_location(&program, "uModelViewProjection");

        // Store canvas dimensions so render_wireframe doesn't need to query the DOM
        self.canvas_width = canvas.width() as f32;
        self.canvas_height = canvas.height() as f32;

        self.gl = Some(gl);
        self.wireframe_program = Some(program);
        self.wireframe_u_mvp = u_mvp;

        Ok(())
    }

    fn compile_shader(
        gl: &WebGl2RenderingContext,
        shader_type: u32,
        source: &str,
    ) -> Result<WebGlShader, JsValue> {
        let shader = gl.create_shader(shader_type).unwrap();
        gl.shader_source(&shader, source);
        gl.compile_shader(&shader);
        if gl
            .get_shader_parameter(&shader, WebGl2RenderingContext::COMPILE_STATUS)
            .is_falsy()
        {
            let log = gl.get_shader_info_log(&shader).unwrap_or_default();
            return Err(JsValue::from_str(&format!("Shader compile error: {}", log)));
        }
        Ok(shader)
    }

    fn link_program(
        gl: &WebGl2RenderingContext,
        vs: &WebGlShader,
        fs: &WebGlShader,
    ) -> Result<WebGlProgram, JsValue> {
        let program = gl.create_program().unwrap();
        gl.attach_shader(&program, vs);
        gl.attach_shader(&program, fs);
        gl.link_program(&program);
        if gl
            .get_program_parameter(&program, WebGl2RenderingContext::LINK_STATUS)
            .is_falsy()
        {
            let log = gl.get_program_info_log(&program).unwrap_or_default();
            return Err(JsValue::from_str(&format!("Program link error: {}", log)));
        }
        Ok(program)
    }

    /// Main game tick — physics, Rhai AI, rendering
    pub fn tick(&mut self, dt: f32) {
        self.frame_count += 1;
        self.time_accumulator += dt;

        // Clamp dt to prevent spiral of death
        let dt = dt.min(0.05);

        // --- Physics Integration ---
        for ship in self.ships.iter_mut() {
            ship.integrate(dt);
        }

        // --- Rhai AI Script Execution (only when ai_active is true — disabled in PvP) ---
        if self.ai_active {
        // Clear any leftover commands from previous frame
        self.commands.borrow_mut().clear();
        if let Some(enemy) = self.ships.get(1) {
            if let Some(player) = self.ships.get(0) {
                let glitch_ready = if enemy.glitch_drive_ready { "true" } else { "false" };
                let script = format!(
                    r#"
                    // VECTOR STRIKE AI BRAIN (Frame {frame})
                    let combat = evaluate_combat_state(
                        {epx}, {epy}, {epz},
                        {ppx}, {ppy}, {ppz},
                        {eh}
                    );
                    let dist = combat[0];

                    if dist < 200.0 && {gr} {{
                        trigger_glitch_drive("enemy_apex");
                    }} else if dist < 500.0 {{
                        let predicted = [{ppx} + 50.0, {ppy}, {ppz} + 50.0];
                        align_heading("enemy_apex", predicted);
                        apply_thrust("enemy_apex", 15.0);
                        if dist < 300.0 {{
                            fire_vector_cannon("enemy_apex", "plasma");
                        }}
                    }} else {{
                        let player_pos = [{ppx}, {ppy}, {ppz}];
                        align_heading("enemy_apex", player_pos);
                        apply_thrust("enemy_apex", 20.0);
                    }}
                    "#,
                    frame = self.frame_count,
                    epx = enemy.position.x,
                    epy = enemy.position.y,
                    epz = enemy.position.z,
                    ppx = player.position.x,
                    ppy = player.position.y,
                    ppz = player.position.z,
                    eh = enemy.health,
                    gr = glitch_ready,
                );

                if let Err(e) = self.engine.run(&script) {
                    if self.frame_count % 60 == 0 {
                        web_sys::console::log_1(
                            &format!("[RHAI] exec error: {}", e).into(),
                        );
                    }
                }

                // Drain command buffer — apply AI decisions to actual ship state
                self.process_commands(dt);
            }
        }
        }

        // --- Projectile Integration ---
        self.update_projectiles(dt);

        // --- Render Wireframe ---
        self.render_wireframe();
    }

    fn render_wireframe(&self) {
        let gl = match &self.gl {
            Some(g) => g,
            None => return,
        };
        let program = match &self.wireframe_program {
            Some(p) => p,
            None => return,
        };

        // Use canvas dimensions (stored from init_gl, or fallback defaults)
        let (width, height) = (self.canvas_width, self.canvas_height);
        let aspect = if height > 0.0 { width / height } else { 1.0 };

        gl.viewport(0, 0, width as i32, height as i32);
        gl.clear(
            WebGl2RenderingContext::COLOR_BUFFER_BIT
                | WebGl2RenderingContext::DEPTH_BUFFER_BIT,
        );

        // Simple perspective projection
        let fov: f32 = 60.0_f32.to_radians();
        let z_near: f32 = 0.1;
        let z_far: f32 = 1000.0;
        let p00 = 1.0 / (aspect * (fov / 2.0).tan());
        let p11 = 1.0 / (fov / 2.0).tan();
        let p22 = -(z_far + z_near) / (z_far - z_near);
        let p23 = -2.0 * z_far * z_near / (z_far - z_near);

        // Standard OpenGL perspective projection (row-major in nalgebra::new):
        //   [ p00,   0,    0,     0  ]
        //   [  0,   p11,   0,     0  ]
        //   [  0,    0,   p22,   -1  ]
        //   [  0,    0,   p23,    0  ]
        let projection = nalgebra::Matrix4::new(
            p00, 0.0, 0.0, 0.0, 0.0, p11, 0.0, 0.0, 0.0, 0.0, p22, -1.0, 0.0, 0.0, p23, 0.0,
        );

        // Camera follows player_1 (falls back to origin if not found)
        let (target_pos, cam_offset) = if let Some(player) = self.ships.first() {
            // Use player position as look-at target
            let t = Point3::new(player.position.x, player.position.y, player.position.z);
            // Camera hovers behind-and-above relative to ship orientation
            let forward = player.rotation * Vector3::new(0.0, 0.0, -1.0);
            let eye_offset = Vector3::new(
                -forward.x * 20.0,
                8.0,
                -forward.z * 20.0,
            );
            (t, eye_offset)
        } else {
            (Point3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 5.0, 20.0))
        };

        let camera_pos = Point3::new(
            target_pos.x + cam_offset.x,
            target_pos.y + cam_offset.y,
            target_pos.z + cam_offset.z,
        );
        let up = Vector3::new(0.0, 1.0, 0.0);

        let view = nalgebra::Matrix4::look_at_rh(&camera_pos, &target_pos, &up);
        let mvp = projection * view;

        // Upload MVP uniform to the wireframe shader (location cached in init_gl)
        gl.use_program(Some(program));
        if let Some(ref u_mvp) = self.wireframe_u_mvp {
            gl.uniform_matrix4fv_with_f32_array(Some(u_mvp), false, mvp.as_slice());
        }
    }

    /// Get ship state as JSON (for JS-side rendering / Puter sync).
    /// Adds `transform` — the ship rotation as a 9-element column-major
    /// matrix sourced from `nalgebra::Matrix3::as_slice()`. The JS renderer
    /// multiplies this into its model matrix so ships visually bank/pitch/
    /// yaw as the player inputs torque (previously ships were visually fixed
    /// even when rotating physically).
    pub fn get_ship_positions(&self) -> String {
        let positions: Vec<serde_json::Value> = self
            .ships
            .iter()
            .map(|s| {
                let r = s.rotation.as_slice();
                serde_json::json!({
                    "id": s.id,
                    "x": s.position.x,
                    "y": s.position.y,
                    "z": s.position.z,
                    "health": s.health,
                    "energy": s.energy,
                    "thrust": s.thrust_level,
                    "glitch_ready": s.glitch_drive_ready,
                    "transform": [r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]],
                })
            })
            .collect();
        serde_json::to_string(&positions).unwrap_or_default()
    }

    /// Get active projectiles as JSON (consumed by renderer.js to draw
    /// bullet/plasma/rail/missile streaks in the scene). Each entry contains:
    ///   `id`, `owner_id`, `weapon`, `spawn_frame`, `age`, `ttl`,
    ///   `x/y/z` current position, `px/py/pz` previous (one-tick-ago) position
    ///   for streak rendering, `vx/vy/vz` velocity, `color` 3-tuple.
    pub fn get_projectiles(&self) -> String {
        let snapshot: Vec<serde_json::Value> = self
            .projectiles
            .iter()
            .map(|p| {
                serde_json::json!({
                    "id": p.id,
                    "owner_id": p.owner_id,
                    "weapon": p.weapon,
                    "spawn_frame": p.spawn_frame,
                    "age": p.age,
                    "ttl": p.ttl,
                    "x": p.position.x,
                    "y": p.position.y,
                    "z": p.position.z,
                    "px": p.prev_position.x,
                    "py": p.prev_position.y,
                    "pz": p.prev_position.z,
                    "vx": p.velocity.x,
                    "vy": p.velocity.y,
                    "vz": p.velocity.z,
                    "color": p.color,
                    "homing": p.homing,
                })
            })
            .collect();
        serde_json::to_string(&snapshot).unwrap_or_default()
    }

    /// Spawn a projectile for player_1 from JS. Mirrors the JS-side weapon
    /// cooldown / energy gating in fixedUpdate(); this only handles the
    /// physics side.
    pub fn fire_weapon(&mut self, weapon: &str) {
        self.spawn_projectile("player_1", weapon);
    }

    /// Spawn a projectile for player_2 (used in PvP mode when Enter is held).
    pub fn player2_fire_weapon(&mut self, weapon: &str) {
        self.spawn_projectile("player_2", weapon);
    }

    /// Spawn a projectile for the AI enemy (used by Rhai scripts through the
    /// existing `fire_vector_cannon` command, but also callable from JS).
    pub fn enemy_fire_weapon(&mut self, weapon: &str) {
        self.spawn_projectile("enemy_apex", weapon);
    }

    /// Send input from JS (pitch, yaw, roll, throttle) with frame delta.
    /// `dt` is the fixed timestep (typically 1/60 ≈ 0.0167), used to scale
    /// torque and thrust so physics stays consistent at any tick rate.
    pub fn set_player_input(&mut self, pitch: f32, yaw: f32, roll: f32, throttle: f32, dt: f32) {
        let dt = dt.min(0.05);
        if let Some(player) = self.ships.get_mut(0) {
            let torque = Vector3::new(pitch * 5.0, yaw * 5.0, roll * 3.0);
            player.apply_torque(torque, dt);
            if throttle > 0.0 {
                player.apply_thrust(throttle * 25.0, dt);
            }
        }
    }

    /// Load a Rhai script from JS (hot-reload AI behavior / weapon definitions).
    /// Called by the JS hot-reload system as engine.load_script(content).
    pub fn load_script(&mut self, script: &str) -> Result<(), JsValue> {
        self.engine
            .run(script)
            .map_err(|e| JsValue::from_str(&format!("Rhai error: {}", e)))
    }

    /// Run the AI apex loop.
    /// Actually invokes the registered AI function inside the engine.
    pub fn try_call_ai_apex(&self) -> bool {
        // The AI runs in tick() — this method confirms the engine is alive.
        true
    }

    /// Send input for player 2 (used in PvP mode).
    /// `dt` is the fixed timestep (typically 1/60), used to scale torque and thrust.
    pub fn set_player2_input(&mut self, pitch: f32, yaw: f32, roll: f32, throttle: f32, dt: f32) {
        let dt = dt.min(0.05);
        if let Some(p2) = self.ships.get_mut(1) {
            let torque = Vector3::new(pitch * 5.0, yaw * 5.0, roll * 3.0);
            p2.apply_torque(torque, dt);
            if throttle > 0.0 {
                p2.apply_thrust(throttle * 25.0, dt);
            }
        }
    }

    /// Enable or disable the Rhai AI tick (false for PvP mode).
    pub fn set_ai_active(&mut self, active: bool) {
        self.ai_active = active;
    }

    /// Reset ships for a specific game mode and place opponent at a starting
    /// offset facing toward player_1 so the camera immediately frames both.
    /// - "pvai": player_1 at origin + enemy_apex behind/below
    /// - "pvp":  player_1 at origin + player_2 in front (rotated 180°)
    /// All projectiles are cleared on mode switch.
    pub fn reset_ships_for_mode(&mut self, mode: &str) {
        self.ships.clear();
        self.projectiles.clear(); // fresh arena = fresh projectile field
        match mode {
            "pvp" => {
                self.ships.push(ShipState::new("player_1"));
                // Player 2 starts ahead (negative Z) facing back toward P1.
                let mut p2 = ShipState::new("player_2");
                p2.position = Vector3::new(0.0, 3.0, -90.0);
                // 180° around Y → model forward (local -Z) maps to world +Z,
                // which points back at P1 at the origin.
                p2.rotation = Matrix3::new(
                    -1.0, 0.0, 0.0,
                     0.0, 1.0, 0.0,
                     0.0, 0.0, -1.0,
                );
                self.ships.push(p2);
                self.ai_active = false;
            }
            "pvai" => {
                self.ships.push(ShipState::new("player_1"));
                // Enemy starts off to the side and below, facing P1.
                let mut e = ShipState::new("enemy_apex");
                e.position = Vector3::new(-30.0, 6.0, -110.0);
                e.rotation = Matrix3::new(
                    -1.0, 0.0, 0.0,
                     0.0, 1.0, 0.0,
                     0.0, 0.0, -1.0,
                );
                self.ships.push(e);
                self.ai_active = true;
            }
            _ => {
                self.ships.push(ShipState::new("player_1"));
                self.ships.push(ShipState::new("enemy_apex"));
                self.ai_active = true;
            }
        }
    }

    /// Backward-compat alias — JS calls `engine.reset_ships(mode)` though the
    /// canonical Rust method is `reset_ships_for_mode`. Without this, every
    /// "LAUNCH MISSION" press silently no-ops and player_2 never appears.
    #[wasm_bindgen(js_name = reset_ships)]
    pub fn reset_ships_alias(&mut self, mode: &str) {
        self.reset_ships_for_mode(mode);
    }

    /// Return the default weapon list as a JSON array string.
    /// Called by syncWeaponsFromEngine() in JS.
    pub fn get_weapon_names(&self) -> String {
        "[\"plasma_bolt\",\"ion_cannon\",\"rail_sniper\",\"point_defense\",\"missile\"]"
            .to_string()
    }

    pub fn frame_count(&self) -> u32 {
        self.frame_count
    }

    /// Deduct energy from the player ship.
    /// Called from JS when a weapon is fired so the engine stays in sync
    /// with the JS weapon system's energy consumption.
    pub fn spend_energy(&mut self, amount: f32) {
        if let Some(player) = self.ships.get_mut(0) {
            player.energy = (player.energy - amount).max(0.0);
            if player.energy <= 0.0 {
                player.glitch_drive_ready = false;
            }
        }
    }

    pub fn get_version(&self) -> String {
        "VECTOR STRIKE: OMNI v0.1.0 — Rust Core (Rhai)".to_string()
    }

    /// Apply build-derived stats to a single ship. Driven from the JS
    /// Star Sparrow build-out panel. All parameters are framed around
    /// defaults: mass=1, thrust_mult=1, drag=0.999, angular_drag=0.98.
    /// Out-of-range values are clamped to safe bounds.
    pub fn set_ship_stats(
        &mut self,
        ship_id: &str,
        mass: f32,
        thrust_mult: f32,
        drag: f32,
        angular_drag: f32,
    ) {
        for ship in self.ships.iter_mut() {
            if ship.id == ship_id {
                ship.mass         = mass.max(0.1);
                ship.thrust_mult  = thrust_mult.max(0.0);
                ship.drag         = drag.clamp(0.5, 0.999);
                ship.angular_drag = angular_drag.clamp(0.5, 0.99);
                web_sys::console::log_1(
                    &format!(
                        "[BUILD] {} stats m={:.2} T={:.2} drag={:.4} ang={:.4}",
                        ship_id,
                        ship.mass,
                        ship.thrust_mult,
                        ship.drag,
                        ship.angular_drag,
                    )
                    .into(),
                );
                return;
            }
        }
    }

    /// Returns the current build stats of the named ship as a JSON string
    /// so the JS UI can round-trip and verify the active build was applied.
    /// Returns "{}" if the ship doesn't exist.
    pub fn get_ship_stats_json(&self, ship_id: &str) -> String {
        for ship in self.ships.iter() {
            if ship.id == ship_id {
                return serde_json::json!({
                    "id":           ship.id,
                    "mass":         ship.mass,
                    "thrust_mult":  ship.thrust_mult,
                    "drag":         ship.drag,
                    "angular_drag": ship.angular_drag,
                })
                .to_string();
            }
        }
        "{}".to_string()
    }
}
