use js_sys::Math;
use mlua::prelude::*;
use nalgebra::{Matrix3, Vector3};
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
    lua: Lua,
    ships: Vec<ShipState>,
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
        let lua = Lua::new();

        // Register Rust functions exposed to Lua
        GameEngine::register_lua_functions(&lua);

        // Preload core Lua gameplay scripts
        if let Err(e) = lua
            .load(
                r#"
                -- VECTOR STRIKE: OMNI Core Lua Environment
                function vector_distance(a, b)
                    local dx = a[1] - b[1]
                    local dy = a[2] - b[2]
                    local dz = a[3] - b[3]
                    return math.sqrt(dx*dx + dy*dy + dz*dz)
                end

                function normalize(v)
                    local mag = math.sqrt(v[1]*v[1] + v[2]*v[2] + v[3]*v[3])
                    if mag == 0 then return {0,0,0} end
                    return {v[1]/mag, v[2]/mag, v[3]/mag}
                end

                -- Default combat AI (overridable)
                function evaluate_combat_state(enemy_pos, player_pos, enemy_health, player_health)
                    local dist = vector_distance(enemy_pos, player_pos)
                    local threat = 0
                    if dist < 300 then threat = 1.0
                    elseif dist < 800 then threat = 0.5
                    else threat = 0.1 end
                    return { distance = dist, threat_level = threat }
                end
            "#,
            )
            .exec()
        {
            let _ = web_sys::console::log_1(&format!("Lua init error: {}", e).into());
        }

        GameEngine {
            lua,
            ships: vec![ShipState::new("player_1"), ShipState::new("enemy_apex")],
            frame_count: 0,
            time_accumulator: 0.0,
            gl: None,
            wireframe_program: None,
        }
    }

    fn register_lua_functions(lua: &Lua) {
        let apply_thrust_fn = lua
            .create_function(|_, (ship_id, force): (String, f32)| {
                // This is called from Lua; handled via globals in tick
                Ok(())
            })
            .unwrap();
        lua.globals()
            .set("apply_thrust", apply_thrust_fn)
            .unwrap();

        let fire_weapon_fn = lua
            .create_function(|_, (ship_id, weapon_type): (String, String)| {
                let msg = format!("[WEAPON] {} fired {}", ship_id, weapon_type);
                web_sys::console::log_1(&msg.into());
                Ok(true)
            })
            .unwrap();
        lua.globals()
            .set("fire_vector_cannon", fire_weapon_fn)
            .unwrap();

        let get_distance_fn = lua
            .create_function(|_, ()| -> LuaResult<f32> { Ok(600.0) })
            .unwrap();
        lua.globals()
            .set("get_distance_to_target", get_distance_fn)
            .unwrap();

        let trigger_glitch = lua
            .create_function(|_, (ship_id,): (String,)| {
                let msg = format!("[GLITCH] {} initiated quantum drive!", ship_id);
                web_sys::console::log_1(&msg.into());
                Ok(())
            })
            .unwrap();
        lua.globals()
            .set("trigger_glitch_drive", trigger_glitch)
            .unwrap();

        let align_heading_fn = lua
            .create_function(|_, (ship_id, target_pos): (String, Vec<f32>)| {
                let msg = format!(
                    "[AI] {} aligning to target ({:.1}, {:.1}, {:.1})",
                    ship_id, target_pos[0], target_pos[1], target_pos[2]
                );
                web_sys::console::log_1(&msg.into());
                Ok(())
            })
            .unwrap();
        lua.globals()
            .set("align_heading", align_heading_fn)
            .unwrap();
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
        if gl.get_shader_parameter(&shader, WebGl2RenderingContext::COMPILE_STATUS).is_falsy() {
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
        if gl.get_program_parameter(&program, WebGl2RenderingContext::LINK_STATUS).is_falsy() {
            let log = gl.get_program_info_log(&program).unwrap_or_default();
            return Err(JsValue::from_str(&format!("Program link error: {}", log)));
        }
        Ok(program)
    }

    /// Main game tick — physics, Lua AI, rendering
    pub fn tick(&mut self, dt: f32) {
        self.frame_count += 1;
        self.time_accumulator += dt;

        // Clamp dt to prevent spiral of death
        let dt = dt.min(0.05);

        // --- Physics Integration ---
        for ship in self.ships.iter_mut() {
            ship.integrate(dt);
        }

        // --- Lua AI Script Execution ---
        if let Some(enemy) = self.ships.get(1) {
            if let Some(player) = self.ships.get(0) {
                let script = format!(
                    r#"
                    -- VECTOR STRIKE AI BRAIN (Frame {frame})
                    local enemy_pos = {{{epx}, {epy}, {epz}}}
                    local player_pos = {{{ppx}, {ppy}, {ppz}}}
                    local enemy_health = {eh}
                    local glitch_ready = {gr}

                    local combat = evaluate_combat_state(enemy_pos, player_pos, enemy_health, 100)

                    if combat.distance < 200.0 and glitch_ready then
                        trigger_glitch_drive("enemy_apex")
                    elseif combat.distance < 500.0 then
                        -- Predictive targeting
                        local predicted = {{player_pos[1] + 50, player_pos[2], player_pos[3] + 50}}
                        align_heading("enemy_apex", predicted)
                        apply_thrust("enemy_apex", 15.0)
                        if combat.distance < 300.0 then
                            fire_vector_cannon("enemy_apex", "plasma")
                        end
                    else
                        -- Approach
                        align_heading("enemy_apex", player_pos)
                        apply_thrust("enemy_apex", 20.0)
                    end
                    "#,
                    frame = self.frame_count,
                    epx = enemy.position.x,
                    epy = enemy.position.y,
                    epz = enemy.position.z,
                    ppx = player.position.x,
                    ppy = player.position.y,
                    ppz = player.position.z,
                    eh = enemy.health,
                    gr = if enemy.glitch_drive_ready { "true" } else { "false" },
                );

                if let Err(e) = self.lua.load(&script).exec() {
                    if self.frame_count % 60 == 0 {
                        web_sys::console::log_1(&format!("[LUA] exec error: {}", e).into());
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
        gl.clear(WebGl2RenderingContext::COLOR_BUFFER_BIT | WebGl2RenderingContext::DEPTH_BUFFER_BIT);

        // Simple perspective projection
        let fov: f32 = 60.0_f32.to_radians();
        let z_near: f32 = 0.1;
        let z_far: f32 = 1000.0;
        let p00 = 1.0 / (aspect * (fov / 2.0).tan());
        let p11 = 1.0 / (fov / 2.0).tan();
        let p22 = -(z_far + z_near) / (z_far - z_near);
        let p23 = -2.0 * z_far * z_near / (z_far - z_near);

        let projection = nalgebra::Matrix4::new(
            p00, 0.0, 0.0, 0.0,
            0.0, p11, 0.0, 0.0,
            0.0, 0.0, p22, p23,
            0.0, 0.0, -1.0, 0.0,
        );

        // Camera looking at origin from behind player
        let camera_pos = nalgebra::Vector3::new(0.0, 5.0, 20.0);
        let target = nalgebra::Vector3::new(0.0, 0.0, 0.0);
        let up = nalgebra::Vector3::new(0.0, 1.0, 0.0);

        let view = nalgebra::Matrix4::look_at_rh(&camera_pos, &target, &up);
        let mvp = projection * view;

        // Upload MVP uniform (placeholder — in full implementation we'd bind vertex buffers)
        let u_mvp = gl.get_uniform_location(program, "uModelViewProjection");
        gl.use_program(Some(program));

        // If we had buffers, we'd render here
        // For now the engine initializes the pipeline and reports readiness to JS
        // Actual vertex data is provided by JS-side wireframe mesh generator
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
                })
            })
            .collect();
        serde_json::to_string(&positions).unwrap_or_default()
    }

    /// Send input from JS (throttle, pitch, yaw, roll)
    pub fn set_player_input(&mut self, pitch: f32, yaw: f32, roll: f32, throttle: f32) {
        if let Some(player) = self.ships.get_mut(0) {
            let torque = Vector3::new(pitch * 5.0, yaw * 5.0, roll * 3.0);
            player.apply_torque(torque, 0.016);
            if throttle > 0.0 {
                player.apply_thrust(throttle * 25.0, 0.016);
            }
        }
    }

    /// Load a Lua script from JS (hot-reload AI behavior)
    pub fn load_lua_script(&mut self, script: &str) -> Result<(), JsValue> {
        self.lua
            .load(script)
            .exec()
            .map_err(|e| JsValue::from_str(&format!("Lua error: {}", e)))?;
        Ok(())
    }

    pub fn frame_count(&self) -> u32 {
        self.frame_count
    }

    pub fn get_version(&self) -> String {
        "VECTOR STRIKE: OMNI v0.1.0 — Rust Core".to_string()
    }
}
