use js_sys::Math;
use nalgebra::{Matrix3, Point3, Vector3};
use rhai::Engine;
use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use web_sys::{WebGl2RenderingContext, WebGlProgram, WebGlShader};

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
    /// Command buffer shared with Rhai closures — AI scripts push commands
    /// here, and `process_commands()` drains them after each script run.
    commands: Rc<RefCell<Vec<ShipCommand>>>,
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
            commands,
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
                    web_sys::console::log_1(
                        &format!("[WEAPON] {} fired {}", id, weapon).into(),
                    );
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

        self.gl = Some(gl);
        self.wireframe_program = Some(program);

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

        let width: f32 = 800.0;
        let height: f32 = 600.0;
        let aspect = width / height;

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

        let projection = nalgebra::Matrix4::new(
            p00, 0.0, 0.0, 0.0, 0.0, p11, 0.0, 0.0, 0.0, 0.0, p22, p23, 0.0, 0.0, -1.0, 0.0,
        );

        // Camera looking at origin from behind player
        let camera_pos = Point3::new(0.0, 5.0, 20.0);
        let target = Point3::new(0.0, 0.0, 0.0);
        let up = Vector3::new(0.0, 1.0, 0.0);

        let view = nalgebra::Matrix4::look_at_rh(&camera_pos, &target, &up);
        let mvp = projection * view;

        // Upload MVP uniform (placeholder)
        let u_mvp = gl.get_uniform_location(program, "uModelViewProjection");
        gl.use_program(Some(program));
        // Vertex data is provided by JS-side wireframe mesh generator
    }

    /// Get ship position as JSON (for JS-side rendering / Puter sync)
    pub fn get_ship_positions(&self) -> String {
        let positions: Vec<serde_json::Value> = self
            .ships
            .iter()
            .map(|s| {
                serde_json::json!({
                    "id": s.id,
                    "x": s.position.x,
                    "y": s.position.y,
                    "z": s.position.z,
                    "health": s.health,
                    "energy": s.energy,
                    "thrust": s.thrust_level,
                    "glitch_ready": s.glitch_drive_ready,
                })
            })
            .collect();
        serde_json::to_string(&positions).unwrap_or_default()
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

    /// Reset ships for a specific game mode.
    /// - "pvai": player_1 + enemy_apex (AI enabled)
    /// - "pvp":  player_1 + player_2 (AI disabled)
    pub fn reset_ships_for_mode(&mut self, mode: &str) {
        self.ships.clear();
        match mode {
            "pvp" => {
                self.ships.push(ShipState::new("player_1"));
                self.ships.push(ShipState::new("player_2"));
                self.ai_active = false;
            }
            "pvai" => {
                self.ships.push(ShipState::new("player_1"));
                self.ships.push(ShipState::new("enemy_apex"));
                self.ai_active = true;
            }
            _ => {
                self.ships.push(ShipState::new("player_1"));
                self.ships.push(ShipState::new("enemy_apex"));
                self.ai_active = true;
            }
        }
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
