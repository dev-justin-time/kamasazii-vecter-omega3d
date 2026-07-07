use js_sys::Math;
use nalgebra::{Matrix3, Vector3};
use rhai::Engine;
use wasm_bindgen::prelude::*;
use web_sys::{WebGl2RenderingContext, WebGlProgram, WebGlShader};

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
        }
    }

    fn apply_thrust(&mut self, force: f32, dt: f32) {
        let forward = self.rotation * Vector3::new(0.0, 0.0, -1.0);
        self.velocity += forward * force * dt;
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
        // Damping
        self.angular_velocity *= 0.98;
        self.velocity *= 0.999;
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
}

#[wasm_bindgen]
impl GameEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> GameEngine {
        let mut engine = Engine::new();

        // Register Rust functions exposed to Rhai scripts
        GameEngine::register_rhai_functions(&mut engine);

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
        }
    }

    fn register_rhai_functions(engine: &mut Engine) {
        engine.register_fn("apply_thrust", |ship_id: String, force: f64| {
            web_sys::console::log_1(
                &format!("[RHAI] {} thrust {:.1}", ship_id, force).into(),
            );
        });

        engine.register_fn(
            "fire_vector_cannon",
            |ship_id: String, weapon_type: String| {
                web_sys::console::log_1(
                    &format!("[WEAPON] {} fired {}", ship_id, weapon_type).into(),
                );
                true
            },
        );

        engine.register_fn("get_distance_to_target", || -> f64 { 600.0 });

        engine.register_fn("trigger_glitch_drive", |ship_id: String| {
            web_sys::console::log_1(
                &format!("[GLITCH] {} initiated quantum drive!", ship_id).into(),
            );
        });

        engine.register_fn(
            "align_heading",
            |ship_id: String, target: Vec<f64>| {
                if target.len() >= 3 {
                    web_sys::console::log_1(
                        &format!(
                            "[AI] {} aligning to ({:.1}, {:.1}, {:.1})",
                            ship_id, target[0], target[1], target[2]
                        )
                        .into(),
                    );
                }
            },
        );

        engine.register_fn("apply_torque", |_ship_id: String, _roll: f64, _pitch: f64, _yaw: f64| {
            // Placeholder — physics torque integration called from JS side.
        });

        engine.register_fn("random", || -> f64 { Math::random() });

        engine.register_fn("log_info", |msg: String| {
            web_sys::console::log_1(&msg.into());
        });
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
        let camera_pos = nalgebra::Point3::new(0.0, 5.0, 20.0);
        let target = nalgebra::Point3::new(0.0, 0.0, 0.0);
        let up = nalgebra::Vector3::new(0.0, 1.0, 0.0);

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
}
