# VECTOR STRIKE: OMNI

> **Air-to-air combat gaming in the Kamikazzi universe.**  
> *Rust + Rhai + Go + Puter.js — a multi-language cyberpunk dogfighter.*

---

## 🏗️ Architecture Stack

| Layer | Technology | Role |
|-------|-----------|------|
| **Core Engine** | Rust → WebAssembly | 6DOF physics, ECS, WebGL2 wireframe rendering at 60+ FPS |
| **Brain** | Rhai (embedded in Rust) | Gameplay logic, AI behavior trees, weapon scripting — hot-reloadable |
| **Authority** | Go (WebSocket server) | Authoritative multiplayer state, hit-registration, matchmaking, anti-cheat |
| **Cloud & AI** | Puter.js (browser SDK) | Cloud saves (replays), persistent player loadouts (KV store), AI-generated mission briefings |

---

## 🚀 Quick Start

```bash
# 1. Serve the frontend
python -m http.server 8765
# Open http://localhost:8765/

# 2. Start the Go multiplayer server
cd server && go run .
# WebSocket endpoint: ws://localhost:8080/ws

# 3. (Optional) Compile Rust engine to Wasm
# Requires wasm-pack: cargo install wasm-pack
wasm-pack build --target web --out-dir pkg --release
```

---

## 📁 Project Structure

```
kamasazii_vecter_omega3d/
├── Cargo.toml                     # Rust crate config (wasm-bindgen, web-sys, rhai, nalgebra)
├── src/
│   └── lib.rs                     # Rust engine: Wasm bindings, Rhai VM, 6DOF physics, WebGL2
├── scripts/
│   ├── ai_apex.rhai               # Neural AI behavior tree (predictive targeting, glitch drive)
│   └── weapons.rhai               # Weapon definitions (plasma, ion, rail, missile, point defense)
├── server/
│   ├── main.go                    # Go authoritative server: WebSockets, rooms, anti-cheat
│   └── go.mod                     # Go module (gorilla/websocket)
├── index.html                     # Frontend: Puter.js SDK, WebGL canvas, HUD, game loop
├── style.css                      # Cyberpunk wireframe aesthetic
├── package.json                   # Build scripts
├── pkg/                           # Generated Wasm output (after wasm-pack build)
└── README.md                      # This file
```

---

## 🧠 Rust Core Engine (`Cargo.toml` + `src/lib.rs`)

The engine compiles to **WebAssembly** via `wasm-bindgen` and exposes:

- **`GameEngine`** — Main Wasm export with constructor, tick(), init_gl(), set_player_input()
- **Rhai scripting bridge** — `rhai` 1.19, registers Rust functions (apply_thrust, fire_vector_cannon, trigger_glitch_drive) into the Rhai engine
- **6DOF physics** — `nalgebra` Vector3/Matrix3 for position, velocity, rotation, angular velocity, integration with damping
- **WebGL2 wireframe renderer** — Perspective projection, lookAt camera, neon shaders

```rust
// Exposed to JavaScript:
let engine = new GameEngine();
engine.init_gl("gameCanvas");
engine.set_player_input(pitch, yaw, roll, throttle);
engine.tick(dt);
let positions = engine.get_ship_positions(); // JSON
```

---

## 🧩 Rhai Scripting (`scripts/`)

Scripts are **loaded dynamically** into the Rust Wasm Rhai engine — edit without recompiling.

### `ai_apex.rhai`
- **Tier 3 Neural AI** — Behavioral state machine with 5 states:
  1. **Glitch Drive** — Emergency quantum displacement at close range
  2. **Evasive Retreat** — Low-health disengagement
  3. **Attack** — Close-range aggressive pursuit with jinking
  4. **Pursuit** — Medium-range intercept prediction
  5. **Patrol** — Long-range sweeping approach
- Formation flying support for squadrons
- Barrel roll evasion at knife-fight range

### `weapons.rhai`
- 5 weapon types with unique stats (damage, speed, cooldown, energy cost, range, color)
- Overheat system with penalty/shutdown thresholds
- Dynamic weapon selection based on distance and energy

```rhai
// Example AI behavior
fn update_ai(enemy_ship, player_ship, game_time) {
    let dist = vector_distance(enemy_ship.pos, player_ship.pos);
    if dist < 200.0 && enemy_ship.glitch_drive_ready {
        trigger_glitch_drive(enemy_ship.id);
    } else {
        align_heading(enemy_ship.id, predicted_pos);
        apply_thrust(enemy_ship.id, 15.0);
    }
}
```

---

## 🌐 Go Multiplayer Server (`server/main.go`)

The authoritative game server:

- **WebSocket** via `gorilla/websocket` on port `:8080`
- **Room-based matchmaking** — auto-creates/destroys rooms
- **60 Hz authoritative tick** — server validates all physics (anti-cheat speed limits)
- **Player state sync** — position, velocity, health, energy, score broadcast
- **Collision detection** — projectile-to-player hits with kill credit
- **Glitch drive** — quantum displacement with cooldown enforcement
- **CLI logging** — connection, disconnect, room lifecycle

```
> go run .
═══════════════════════════════════════════
  VECTOR STRIKE: OMNI — Go Game Server
  Listening on :8080
  WebSocket endpoint: /ws
═══════════════════════════════════════════
```

---

## ☁️ Puter.js Frontend (`index.html`)

The browser frontend uses **no build step** — Puter.js SDK loaded from CDN.

### Features
- **Puter AI** — Dynamic mission briefing generation on every game start
- **Puter KV** — Persistent player loadouts (ship, shader) across sessions
- **Puter FS** — Cloud replay saving to user's Puter Drive
- **WebGL2 wireframe renderer** — Neon cube with camera orbit (placeholder for full scene)
- **Full HUD** — Health, energy, heat bars; FPS counter; weapon display; score
- **WebSocket client** — Connects to Go server, sends/receives state
- **Keyboard controls** — WASD flight, Space fire, G glitch, Q/E roll

### Puter AI: Dynamic Content
```javascript
const response = await puter.ai.chat(
    "Generate a 2-sentence cyberpunk mission briefing for a wireframe dogfighter..."
);
document.getElementById('briefing-text').innerText = response;
```

---

## 🎮 Controls

| Input | Action |
|-------|--------|
| **W / S** | Pitch up / down |
| **A / D** | Yaw left / right |
| **Q / E** | Roll left / right |
| **Shift** | Boost throttle |
| **Space** | Fire weapon |
| **G** | Glitch Drive (quantum displacement) |

---

## 🔧 Build & Deploy

```bash
# Rust → Wasm
wasm-pack build --target web --out-dir pkg --release

# Go server binary
cd server && go build -o ../vector_server .

# Deploy frontend (static files)
# Any static host: GitHub Pages, Cloudflare Pages, Puter Drive
```

---

## 🧪 Stack Benefits

1. **Zero-latency rendering** — Rust → Wasm runs at near-native speeds
2. **Modular gameplay** — Rhai scripts tweak AI/weapons without recompiling
3. **Trustless cloud** — Puter.js gives players cloud saves for free
4. **Server authority** — Go validates inputs, prevents client cheating
5. **Dynamic content** — Puter AI generates unique briefings every session

---

*Part of the [Kamikazzi Branded Game Suite](https://github.com/dev-justin-time/kamikazzi).*  
*Built with Rust, Rhai, Go, and Puter.js.*
