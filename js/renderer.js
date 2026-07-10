// ─── WebGL Wireframe Renderer ────────────────────────────────
// Sets up shaders, VAO, and exposes a render() callback on state.
// Pre-allocates reusable buffers to avoid per-frame GC pressure.

import { mat4Multiply, perspective, lookAt } from './math.js';
import { canvas, gl } from './dom.js';
import { state } from './state.js';
import { ARENA, renderArena } from './arena.js';
import { renderBoundaries } from './boundaries.js';
import { SHIPS, renderShipModel as _renderShipModel } from './ships.js';

// ─── Pre-allocated reusable temporaries (avoid GC in render loop) ──
const _tmpMVP = new Float32Array(16);
const _tmpAnimView = new Float32Array(16);
// Projectile stream buffers — one VAO/buffer pair, sized for the worst-case
// active projectile count (~256 shots × ~6 line endpoints each).
const MAX_PROJ_LINES = 256;
// Each line = 2 verts × 3 floats. Boxes render as 12 lines × 2 verts.
const _projPosBuf = new Float32Array(MAX_PROJ_LINES * 24 * 3);
const _projColBuf = new Float32Array(MAX_PROJ_LINES * 24 * 3);

// Scratch array reused every frame to combine WASM + server-peer
// projectiles into a single line-list batch. Avoids the per-frame
// `combined.concat(peers)` heap allocation under heavy peer-spam.
// Defined at module scope so `state.render` captures it by reference.
const _combinedProjScratch = [];

// ─── Hit-impact spark buffers ────────────────────────────────────────
// Single VAO + dynamic buffers reused every frame for the expanding-ring
// + radial-debris effect drawn at every health-change event. Each impact
// emits ≤64 verts (2 perpendicular rings × 8 segs + 12 debris spokes
// + a few core-flash segments), so MAX_IMPACTS × 64 verts × 3 floats is
// the per-frame buffer size.
const MAX_IMPACTS = 32;
// Per-impact vertex budget: 2 perpendicular rings × 8 segs + 12 spokes × 2 +
// 3 core-flash lines = 62 verts in current code. Sized to 80 (~30% margin) so
// adding crosshair extensions or extra spokes later doesn't cause silent
// `pushLine` overflow drops under bursts of simultaneous hits.
const _MAX_VERTS_PER_IMPACT = 80;
const _impactPosBuf = new Float32Array(MAX_IMPACTS * _MAX_VERTS_PER_IMPACT * 3);
const _impactColBuf = new Float32Array(MAX_IMPACTS * _MAX_VERTS_PER_IMPACT * 3);

// Module-level state for the impact renderer — populated by the health-diff
// loop in `state.render` and consumed by `_renderImpacts(proj, view)`.
let _impactStreamVao = null;
let _impactPosGpu = null;
let _impactColGpu = null;
// Active impact events: { x, y, z, color:[r,g,b], age, ttl, kind }
// `kind` is "hit" (normal damage tick) or "kill" (ship hit zero HP this frame).
const _activeImpacts = [];
// Previous-frame ship-health snapshot keyed by ship id. The detection loop
// in `state.render` compares against this to fire impact events without
// needing to add a new export to the Rust engine.
const _prevShipHealth = new Map();

// Identity 3×3 rotation matrix (column-major) used as a default when a ship
// hasn't reported a `transform` yet. Layout matches what
// `engine.get_ship_positions()` emits.
const IDENTITY_TRANSFORM = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const _defaultShipRot = IDENTITY_TRANSFORM;

let _program, _uMVP, _vao, _vertCount;
let _aPos, _aCol;
// Projectile stream — module-level so initWebGL() can populate them and
// _renderProjectiles() can bind+update them per frame.
let _projStreamVao = null;
let _projPosGpu = null;
let _projColGpu = null;

// ─── Shader compilation ──────────────────────────────────────

export function compileShader(type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('[WEBGL] Shader error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

// ─── WebGL Initialisation ────────────────────────────────────

export function initWebGL() {
    if (!gl) {
        console.warn('[WEBGL] WebGL2 not supported — using fallback');
        return false;
    }

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const vsSrc = `#version 300 es
        in vec3 aPosition;
        in vec3 aColor;
        uniform mat4 uMVP;
        out vec3 vColor;
        void main() {
            gl_Position = uMVP * vec4(aPosition, 1.0);
            vColor = aColor;
            gl_PointSize = 2.0;
        }`;

    const fsSrc = `#version 300 es
        precision highp float;
        in vec3 vColor;
        out vec4 fragColor;
        void main() {
            fragColor = vec4(vColor, 1.0);
        }`;

    const vs = compileShader(gl.VERTEX_SHADER, vsSrc);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return false;

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('[WEBGL] Program link failed');
        return false;
    }

    gl.useProgram(program);
    gl.clearColor(0.0, 0.0, 0.05, 1.0);
    gl.enable(gl.DEPTH_TEST);

    // Wireframe cube placeholder
    const positions = new Float32Array([
        -1,-1,-1, 1,-1,-1,   1,-1,-1, 1,1,-1,
         1,1,-1, -1,1,-1,  -1,1,-1, -1,-1,-1,
        -1,-1, 1, 1,-1, 1,   1,-1, 1, 1,1, 1,
         1,1, 1, -1,1, 1,  -1,1, 1, -1,-1, 1,
        -1,-1,-1, -1,-1, 1, 1,-1,-1, 1,-1, 1,
         1,1,-1, 1,1, 1,  -1,1,-1, -1,1, 1,
    ]);

    const colors = new Float32Array(positions.length);
    for (let i = 0; i < colors.length; i += 3) {
        colors[i] = 0.0; colors[i+1] = 0.94; colors[i+2] = 1.0;
    }

    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const colBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);

    _aPos = gl.getAttribLocation(program, 'aPosition');
    _aCol = gl.getAttribLocation(program, 'aColor');
    _uMVP = gl.getUniformLocation(program, 'uMVP');

    _vao = gl.createVertexArray();        gl.bindVertexArray(_vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
        gl.enableVertexAttribArray(_aPos);
        gl.vertexAttribPointer(_aPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
        gl.enableVertexAttribArray(_aCol);
        gl.vertexAttribPointer(_aCol, 3, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);

        _program = program;
        _vertCount = positions.length / 3;

        // ─── Pre-build projectile stream buffers (single dynamic-draw VAO) ─
        // Geometry for every projectile is flattened into one big line batch
        // and uploaded once per frame with `bufferSubData`. No GL buffer
        // create/delete churn during the render loop.
        _projStreamVao = gl.createVertexArray();
        gl.bindVertexArray(_projStreamVao);
        _projPosGpu = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, _projPosGpu);
        gl.bufferData(gl.ARRAY_BUFFER, _projPosBuf, gl.DYNAMIC_DRAW);
        const _projPosLoc = gl.getAttribLocation(program, 'aPosition');
        gl.enableVertexAttribArray(_projPosLoc);
        gl.vertexAttribPointer(_projPosLoc, 3, gl.FLOAT, false, 0, 0);
        _projColGpu = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, _projColGpu);
        gl.bufferData(gl.ARRAY_BUFFER, _projColBuf, gl.DYNAMIC_DRAW);
        const _projColLoc = gl.getAttribLocation(program, 'aColor');
        gl.enableVertexAttribArray(_projColLoc);
        gl.vertexAttribPointer(_projColLoc, 3, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);

        // ─── Pre-build hit-impact spark VAO (single dynamic-draw) ───
        // Same buffer-reuse pattern as the projectile stream above:
        // geometry for every active hit is flattened into one line batch
        // and uploaded once per frame with `bufferSubData`, so there's no
        // per-frame `createBuffer` / `deleteBuffer` churn.
        _impactStreamVao = gl.createVertexArray();
        gl.bindVertexArray(_impactStreamVao);
        _impactPosGpu = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, _impactPosGpu);
        gl.bufferData(gl.ARRAY_BUFFER, _impactPosBuf, gl.DYNAMIC_DRAW);
        const _impactPosLoc = gl.getAttribLocation(program, 'aPosition');
        gl.enableVertexAttribArray(_impactPosLoc);
        gl.vertexAttribPointer(_impactPosLoc, 3, gl.FLOAT, false, 0, 0);
        _impactColGpu = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, _impactColGpu);
        gl.bufferData(gl.ARRAY_BUFFER, _impactColBuf, gl.DYNAMIC_DRAW);
        const _impactColLoc = gl.getAttribLocation(program, 'aColor');
        gl.enableVertexAttribArray(_impactColLoc);
        gl.vertexAttribPointer(_impactColLoc, 3, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);

        // Share program + uniform with arena & ships modules
        ARENA.program = program;
        ARENA.uMVP = _uMVP;

    // ─── Wire scene state into the render closure ─────────────
    const scene = { angle: 0, scale: 5 };
    let arenaAnimT = 0;
    // Wall-clock dt tracker — used by the hit-impact spark system so ring
    // expansions age correctly regardless of render-loop jitter (the JS
    // `requestAnimationFrame` loop can run faster or slower than 60 Hz).
    let _lastRenderMs = performance.now();

    function evaluateArenaAnimation(t) {
        return [0, Math.sin(t * 0.3) * 0.5, 0];
    }

    state.render = () => {
        // ─── Per-frame wall-clock dt (clamped to prevent death-spiral) ───
        // Used by the hit-impact spark system to age in-flight events at
        // real elapsed time rather than 1/60-frame quantization.
        const _nowMs = performance.now();
        const _renderDt = Math.min(Math.max((_nowMs - _lastRenderMs) / 1000, 0.0), 0.05);
        _lastRenderMs = _nowMs;

        scene.angle += 0.005;
        arenaAnimT += 0.016;

        // ─── Animation offset ───────────────────────────────
        let animOffset;
        if (ARENA.animTimes && ARENA.animTimes.length > 0) {
            const t = Math.min(arenaAnimT % ARENA.animDuration, ARENA.animDuration - 0.001);
            const keys = ARENA.animTimes;
            const vals = ARENA.animTranslations;
            let idx = 0;
            for (let i = 0; i < keys.length - 1; i++) {
                if (t >= keys[i] && t <= keys[i + 1]) { idx = i; break; }
            }
            idx = Math.min(idx, keys.length - 2);
            const t0 = keys[idx], t1 = keys[idx + 1];
            const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
            const i3 = idx * 3;
            animOffset = [
                (vals[i3]     + (vals[i3 + 3] - vals[i3])     * f) * 0.058,
                (vals[i3 + 1] + (vals[i3 + 4] - vals[i3 + 1]) * f) * 0.058,
                (vals[i3 + 2] + (vals[i3 + 5] - vals[i3 + 2]) * f) * 0.058,
            ];
        } else {
            animOffset = evaluateArenaAnimation(arenaAnimT);
        }

        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        const aspect = canvas.width / canvas.height;
        const proj = perspective(Math.PI / 3, aspect, 0.1, 5000.0);

        // ─── Camera ─────────────────────────────────────────
        let eye, center, up = [0, 1, 0];
        if (state.running && state.engine) {
            try {
                const shipData = JSON.parse(state.engine.get_ship_positions());
                const p1 = shipData.find(s => s.id === 'player_1');
                if (p1) {
                    if (state.viewMode === 'first') {
                        // ── Cockpit first-person camera ──────────
                        // Camera sits at the pilot's eye position inside the
                        // ship, looking forward along the ship's nose.
                        const R = p1.transform || _defaultShipRot;
                        // Ship-local forward = -Z, rotated by R:
                        //   world forward = R * (0, 0, -1) = (-R[6], -R[7], -R[8])
                        const fx = -R[6], fy = -R[7], fz = -R[8];
                        // Ship-local up = +Y, rotated by R:
                        //   world up = R * (0, 1, 0) = (R[3], R[4], R[5])
                        const ux = R[3], uy = R[4], uz = R[5];
                        // Pilot eye position: slightly above ship center + slightly forward
                        const cockpitOffsetY = 1.8;
                        const cockpitOffsetZ = 2.5; // forward offset
                        eye = [
                            p1.x + fx * cockpitOffsetZ,
                            p1.y + cockpitOffsetY,
                            p1.z + fz * cockpitOffsetZ,
                        ];
                        // Look far forward along ship's nose
                        const lookDist = 500;
                        center = [
                            eye[0] + fx * lookDist,
                            eye[1] + fy * lookDist,
                            eye[2] + fz * lookDist,
                        ];
                        // Use the ship's actual up vector for full 6DOF roll
                        up = [ux, uy, uz];
                    } else {
                        // ── Third-person chase camera ─────────────
                        center = [p1.x, p1.y, p1.z];
                        eye = [
                            center[0] + Math.sin(scene.angle) * 15,
                            center[1] + 8,
                            center[2] + Math.cos(scene.angle) * 15
                        ];
                    }
                } else {
                    center = [0, 0, 0];
                    eye = [Math.sin(scene.angle) * scene.scale * 10, scene.scale * 5, Math.cos(scene.angle) * scene.scale * 10];
                }
            } catch (_) {
                center = [0, 0, 0];
                eye = [Math.sin(scene.angle)*50, 30, Math.cos(scene.angle)*50];
            }
        } else {
            center = [0, 0, 0];
            eye = [Math.sin(scene.angle) * 200, 120, Math.cos(scene.angle) * 200];
        }

        const view = lookAt(eye, center, up);

        // Apply arena animation offset to view matrix
        let animView = view;
        if (ARENA.loaded) {
            _tmpAnimView.set(view);
            const ax = animOffset[0], ay = animOffset[1], az = animOffset[2];
            _tmpAnimView[12] += view[0]*ax + view[4]*ay + view[8]*az;
            _tmpAnimView[13] += view[1]*ax + view[5]*ay + view[9]*az;
            _tmpAnimView[14] += view[2]*ax + view[6]*ay + view[10]*az;
            animView = _tmpAnimView;
        }

        // ─── Render arena or fallback cube ──────────────────
        if (ARENA.loaded) {
            renderArena(animView, proj);
        } else {
            mat4Multiply(proj, view, _tmpMVP);
            gl.useProgram(_program);
            gl.uniformMatrix4fv(_uMVP, false, _tmpMVP);
            gl.bindVertexArray(_vao);
            gl.drawArrays(gl.LINES, 0, _vertCount);
            gl.bindVertexArray(null);
        }

        // ─── Render arena boundaries (wireframe box) ───────
        renderBoundaries(view, proj);

        // ─── Render ships ───────────────────────────────────
        if (state.engine) {
            // Parse ship positions once at the top so the hit-impact diff
            // loop and the per-ship draw loop share the same array.
            let shipData = [];
            try {
                shipData = JSON.parse(state.engine.get_ship_positions());
            } catch (_) {}

            // ─── Hit-impact detection (diff vs last frame's health) ───
            // Each render frame we compare `shipData[i].health` against the
            // cached value from one frame ago. A drop = a hit event with
            // that ship's position as the impact point; a drop to zero HP
            // = a kill event (bigger ring, longer ttl, brighter core flash).
            try {
                for (let _hi = 0; _hi < shipData.length; _hi++) {
                    const ship = shipData[_hi];
                    const prev = _prevShipHealth.get(ship.id);
                    // First observation for this ship — initialize and skip
                    // (avoids spurious "hits" the frame after `reset_ships`).
                    if (prev === undefined) {
                        _prevShipHealth.set(ship.id, ship.health);
                        continue;
                    }
                    if (ship.health < prev) {
                        const killed = ship.health <= 0.0;
                        _activeImpacts.push({
                            x: ship.x, y: ship.y, z: ship.z,
                            // Warm-white for normal hits; orange-red for
                            // kills so the larger event reads as more violent.
                            color: killed ? [1.0, 0.45, 0.25] : [1.0, 0.92, 0.65],
                            age: 0,
                            ttl: killed ? 0.85 : 0.45,
                            kind: killed ? 'kill' : 'hit',
                        });
                    }
                    _prevShipHealth.set(ship.id, ship.health);
                }
                // Drop stale entries for ships that just left the arena
                // (e.g., after a `reset_ships(mode)` wipes the vec).
                for (const id of [..._prevShipHealth.keys()]) {
                    if (!shipData.some(s => s.id === id)) _prevShipHealth.delete(id);
                }
                // Age existing events by this frame's wall-clock dt; remove
                // those that have outlived their ttl. Done in reverse so
                // splicing doesn't disturb iteration order.
                for (let _a = _activeImpacts.length - 1; _a >= 0; _a--) {
                    _activeImpacts[_a].age += _renderDt;
                    if (_activeImpacts[_a].age >= _activeImpacts[_a].ttl) {
                        _activeImpacts.splice(_a, 1);
                    }
                }
            } catch (_) {}

            try {
                for (const ship of shipData) {
                    const isP1 = ship.id === 'player_1';
                    const isP2 = ship.id === 'player_2';
                    const isEnemy = ship.id === 'enemy_apex';
                    if (!isP1 && !isP2 && !isEnemy) continue;
                    if (isP2 && state.gameMode !== 'pvp') continue;
                    // Skip rendering player's own ship in first-person cockpit view
                    if (isP1 && state.viewMode === 'first') continue;

                    const modelName = SHIPS.assignments[ship.id];
                    const model = modelName ? SHIPS.models[modelName] : null;
                    const color = SHIPS.colors[ship.id] || [0.5, 0.5, 0.5];

                    if (model) {
                        if (model.modular && typeof window.__SS_renderModular === 'function') {
                            window.__SS_renderModular(
                                model,
                                [ship.x, ship.y, ship.z],
                                color,
                                proj,
                                view,
                                ship.transform || _defaultShipRot
                            );
                        } else {
                            _renderShipModel(
                                model,
                                [ship.x, ship.y, ship.z],
                                color,
                                proj,
                                view,
                                ship.transform || _defaultShipRot
                            );
                        }
                    } else {
                        // Fallback: wireframe ship silhouette (arrow/wedge shape)
                        // oriented by the ship's actual rotation matrix.
                        const s = 3;
                        const x = ship.x, y = ship.y, z = ship.z;
                        const R = ship.transform || _defaultShipRot;
                        // Local-space silhouette points (relative to ship center):
                        //   forward = -Z, up = +Y, wingspan along ±X.
                        const local = [
                            // nose, mid-port, mid-starboard, tail-belly, tail-back
                            [0, 0, -s*1.5], [s*0.4, 0, -s*0.5], [-s*0.4, 0, -s*0.5],
                            [0, 0, s*1.0],   [0, s*0.6, s*1.3],
                            // wing-tips
                            [s*1.5, 0, -s*0.8], [-s*1.5, 0, -s*0.8],
                            [s*0.4, 0, -s*0.3], [-s*0.4, 0, -s*0.3],
                            [s*0.3, 0, s*0.7],  [-s*0.3, 0, s*0.7],
                        ];
                        // Helper: project a local point through R + pos to world.
                        const toWorld = (p) => [
                            x + R[0]*p[0] + R[3]*p[1] + R[6]*p[2],
                            y + R[1]*p[0] + R[4]*p[1] + R[7]*p[2],
                            z + R[2]*p[0] + R[5]*p[1] + R[8]*p[2],
                        ];
                        const nose = toWorld(local[0]);
                        const rP   = toWorld(local[1]);
                        const lP   = toWorld(local[2]);
                        const tail = toWorld(local[3]);
                        const tailUp = toWorld(local[4]);
                        const rW   = toWorld(local[5]);
                        const lW   = toWorld(local[6]);
                        const rBack= toWorld(local[7]);
                        const lBack= toWorld(local[8]);
                        const rTail= toWorld(local[9]);
                        const lTail= toWorld(local[10]);
                        const mp = new Float32Array([
                            // Fuselage diamond
                            ...nose, ...rP,
                            ...nose, ...lP,
                            ...rP,   ...tail,
                            ...lP,   ...tail,
                            // Wings
                            ...rP,   ...rW,
                            ...lP,   ...lW,
                            ...rW,   ...rBack,
                            ...lW,   ...lBack,
                            // Tail
                            ...tail, ...tailUp,
                            ...tailUp, ...rTail,
                            ...tailUp, ...lTail,
                        ]);
                        const c = color;
                        const mc = new Float32Array(mp.length);
                        for (let ci = 0; ci < mc.length; ci += 3) {
                            mc[ci] = c[0]; mc[ci+1] = c[1]; mc[ci+2] = c[2];
                        }
                        const pb = gl.createBuffer(), cb = gl.createBuffer();
                        gl.bindBuffer(gl.ARRAY_BUFFER, pb);
                        gl.bufferData(gl.ARRAY_BUFFER, mp, gl.DYNAMIC_DRAW);
                        gl.bindBuffer(gl.ARRAY_BUFFER, cb);
                        gl.bufferData(gl.ARRAY_BUFFER, mc, gl.DYNAMIC_DRAW);
                        mat4Multiply(proj, view, _tmpMVP);
                        gl.useProgram(_program);
                        gl.uniformMatrix4fv(_uMVP, false, _tmpMVP);
                        gl.bindBuffer(gl.ARRAY_BUFFER, pb);
                        gl.enableVertexAttribArray(_aPos);
                        gl.vertexAttribPointer(_aPos, 3, gl.FLOAT, false, 0, 0);
                        gl.bindBuffer(gl.ARRAY_BUFFER, cb);
                        gl.enableVertexAttribArray(_aCol);
                        gl.vertexAttribPointer(_aCol, 3, gl.FLOAT, false, 0, 0);
                        gl.drawArrays(gl.LINES, 0, mp.length / 3);
                        gl.deleteBuffer(pb);
                        gl.deleteBuffer(cb);
                    }
                }
            } catch (_) {}

            // ─── Render hit-impact sparks (expanding rings + debris) ───
            // Skip when nothing is active — avoids a redundant MVP upload
            // and a zero-vertex draw on the vast majority of frames.
            if (_activeImpacts.length) {
                try { _renderImpacts(proj, view); } catch (_) {}
            }
        }

        // ─── Render projectiles (WASM + server peers) ─────────
        // Hoisted out of the `if (state.engine)` block so a live
        // WebSocket connection still draws server-authoritative
        // projectiles even when the WASM engine hasn't finished
        // loading yet — peer → peer combat without a local WASM
        // engine is now fully viewable.
        //
        // Concatenate local WASM projectiles and the multiplayer
        // peerProjectiles snapshot (network.js keeps the latter in
        // sync from each `state` server message) into one line-list
        // batch — same per-weapon geometry / coloring rules apply
        // to both since they're normalized to a single shape.
        try {
            let combined = null;
            try {
                if (state.engine) {
                    const projJson = state.engine.get_projectiles();
                    if (projJson && projJson !== '[]') {
                        const w = JSON.parse(projJson);
                        if (Array.isArray(w) && w.length) combined = w;
                    }
                }
            } catch (_) {}
            const peers = (state.peerProjectiles && state.peerProjectiles.length)
                ? state.peerProjectiles
                : null;
            // Push into the module-scoped scratch buffer instead of
            // allocating a fresh array each frame via `.concat()`.
            _combinedProjScratch.length = 0;
            if (combined) _combinedProjScratch.push.apply(_combinedProjScratch, combined);
            if (peers)    _combinedProjScratch.push.apply(_combinedProjScratch, peers);
            if (_combinedProjScratch.length) {
                _renderProjectiles(JSON.stringify(_combinedProjScratch), proj, view);
            }
        } catch (_) {}
    };

    return true;
}

// ─── Projectile renderer ────────────────────────────────────────────────────────
// Flattens every active projectile's per-frame geometry into a single
// line-list draw call. Geometry per projectile type:
//   plasma_bolt   — streak + small forward X cross
//   ion_cannon    — streak (longer) + square at tip
//   rail_sniper   — long streak only
//   point_defense — short streak only (tracer)
//   missile       — streak + wireframe octahedron body
// Plus a brief muzzle-flash star drawn at fresh (<0.1s) projectile's prev_pos.
function _renderProjectiles(projJson, proj, view) {
    let projectiles;
    try { projectiles = JSON.parse(projJson); } catch (_) { return; }
    if (!Array.isArray(projectiles) || projectiles.length === 0) return;

    let vCursor = 0; // vertex index in _projPosBuf/_projColBuf (floats)
    const pushLine = (ax, ay, az, bx, by, bz, r, g, bl) => {
        if (vCursor + 6 > _projPosBuf.length) return;
        _projPosBuf[vCursor    ] = ax; _projPosBuf[vCursor + 1] = ay; _projPosBuf[vCursor + 2] = az;
        _projPosBuf[vCursor + 3] = bx; _projPosBuf[vCursor + 4] = by; _projPosBuf[vCursor + 5] = bz;
        _projColBuf[vCursor    ] = r; _projColBuf[vCursor + 1] = g; _projColBuf[vCursor + 2] = bl;
        _projColBuf[vCursor + 3] = r; _projColBuf[vCursor + 4] = g; _projColBuf[vCursor + 5] = bl;
        vCursor += 6;
    };
    const pushBox = (cx, cy, cz, half, r, g, bl) => {
        // 12-edge wireframe box from 8 corners centered at (cx,cy,cz).
        const c = [
            [cx - half, cy - half, cz - half], [cx + half, cy - half, cz - half],
            [cx + half, cy + half, cz - half], [cx - half, cy + half, cz - half],
            [cx - half, cy - half, cz + half], [cx + half, cy - half, cz + half],
            [cx + half, cy + half, cz + half], [cx - half, cy + half, cz + half],
        ];
        const E = [
            [0,1],[1,2],[2,3],[3,0],   // back face
            [4,5],[5,6],[6,7],[7,4],   // front face
            [0,4],[1,5],[2,6],[3,7],   // bridges
        ];
        for (const [a, b] of E) {
            pushLine(c[a][0], c[a][1], c[a][2], c[b][0], c[b][1], c[b][2], r, g, bl);
        }
    };
    const pushCross = (cx, cy, cz, half, r, g, bl) => {
        // Simple + cross in 3 orthogonal planes (looks like a bright muzzle).
        pushLine(cx - half, cy, cz, cx + half, cy, cz, r, g, bl);
        pushLine(cx, cy - half, cz, cx, cy + half, cz, r, g, bl);
        pushLine(cx, cy, cz - half, cx, cy, cz + half, r, g, bl);
    };
    const pushSquare = (cx, cy, cz, half, r, g, bl) => {
        // Square cross-section perpendicular to forward axis (visual tip).
        pushLine(cx - half, cy - half, cz, cx + half, cy - half, cz, r, g, bl);
        pushLine(cx + half, cy - half, cz, cx + half, cy + half, cz, r, g, bl);
        pushLine(cx + half, cy + half, cz, cx - half, cy + half, cz, r, g, bl);
        pushLine(cx - half, cy + half, cz, cx - half, cy - half, cz, r, g, bl);
    };

    const projVerts = []; // parallel array of vertex counts (for color buffer sizing)
    for (const p of projectiles) {
        const r = p.color[0], g = p.color[1], bl = p.color[2];

        // Streak: prev_pos → cur_pos. Always at least 2 vertices (1 line).
        pushLine(p.px, p.py, p.pz, p.x, p.y, p.z, r, g, bl);

        const w = p.weapon;
        switch (w) {
            case 'plasma_bolt':
                // Glow tip + cross-hair
                pushCross(p.x, p.y, p.z, 0.4, r, g, bl);
                break;
            case 'ion_cannon':
                pushSquare(p.x, p.y, p.z, 0.7, r, g, bl);
                break;
            case 'rail_sniper':
                pushLine(p.px, p.py, p.pz, p.x + (p.x - p.px) * 1.5,
                         p.y + (p.y - p.py) * 1.5, p.z + (p.z - p.pz) * 1.5, r, g, bl);
                break;
            case 'point_defense':
                pushCross(p.x, p.y, p.z, 0.25, r, g, bl);
                break;
            case 'missile':
                // Wireframe 3D body so it's recognizable in the sky.
                pushBox(p.x, p.y, p.z, 0.9, r, g, bl);
                break;
        }

        // Brief muzzle-flash star: hits the spawn position for the first
        // ~0.1s of a projectile's life (renderer can read age directly).
        if (p.age < 0.1) {
            const intensity = 1.0 - p.age / 0.1;
            pushCross(p.px, p.py, p.pz, 1.0 * intensity, 1, 1, 1);
        }
    }

    if (vCursor === 0 || !_projStreamVao) return;

    // Compute MVP once for the whole stream — every projectile shares it.
    mat4Multiply(proj, view, _tmpMVP);

    // Bind VAO + both buffers, then upload the populated range only.
    gl.bindVertexArray(_projStreamVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, _projPosGpu);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, _projPosBuf.subarray(0, vCursor));
    gl.bindBuffer(gl.ARRAY_BUFFER, _projColGpu);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, _projColBuf.subarray(0, vCursor));
    gl.useProgram(_program);
    gl.uniformMatrix4fv(_uMVP, false, _tmpMVP);
    gl.drawArrays(gl.LINES, 0, vCursor / 3);
    gl.bindVertexArray(null);
}

// ─── Hit-impact ring + debris renderer ────────────────────────────────────────────
// For each active impact event, expands an outward-blowing shock effect:
//   • two perpendicular rings (XY + XZ planes) for 3D presence at any
//     camera angle — 8 line segments each
//   • 12 radial debris spokes that progressively lengthen from inner to
//     outer radius as the impact ages (deterministic φ/θ pattern, no
//     shimmer between frames)
//   • a brighter "core flash" 3D crosshair at the impact point during the
//     first 40% of the impact's ttl (kill events pulse brighter/longer)
// Every active event flattens into one line-list draw call via the impact
// VAO, mirroring the projectile stream renderer's reuse strategy.
function _renderImpacts(proj, view) {
    let vCursor = 0;
    const pushLine = (ax, ay, az, bx, by, bz, r, g, bl) => {
        if (vCursor + 6 > _impactPosBuf.length) return;
        _impactPosBuf[vCursor    ] = ax; _impactPosBuf[vCursor + 1] = ay; _impactPosBuf[vCursor + 2] = az;
        _impactPosBuf[vCursor + 3] = bx; _impactPosBuf[vCursor + 4] = by; _impactPosBuf[vCursor + 5] = bz;
        _impactColBuf[vCursor    ] = r; _impactColBuf[vCursor + 1] = g; _impactColBuf[vCursor + 2] = bl;
        _impactColBuf[vCursor + 3] = r; _impactColBuf[vCursor + 4] = g; _impactColBuf[vCursor + 5] = bl;
        vCursor += 6;
    };

    for (const ev of _activeImpacts) {
        // 0 → fresh, 1 → dying. Both outward scale and brightness fade
        // key off this normalized age.
        const t = Math.min(1.0, ev.age / ev.ttl);
        const fade = 1.0 - t;
        const baseR = ev.kind === 'kill' ? 5.5 : 3.0;
        // Ring expands from 0.4R → 1.0R over the impact's lifetime.
        const radius = baseR * (0.4 + 0.6 * t);

        const [cr, cg, cb] = ev.color;
        const r = cr * fade, g = cg * fade, bl = cb * fade;

        // ─── Two perpendicular 8-segment rings (XY + XZ) ─────
        // XY plane faces +Z; XZ plane faces +Y. Together they read as
        // a 3D shockwave from any camera angle without paying for true
        // camera-aligned billboards.
        const SEGS = 8;
        for (let p = 0; p < 2; p++) {
            const useY = p === 0;
            for (let i = 0; i < SEGS; i++) {
                const a0 = (i     / SEGS) * Math.PI * 2;
                const a1 = ((i+1) / SEGS) * Math.PI * 2;
                const x0 = Math.cos(a0) * radius;
                const x1 = Math.cos(a1) * radius;
                const y0 = useY ? Math.sin(a0) * radius : 0;
                const y1 = useY ? Math.sin(a1) * radius : 0;
                const z0 = useY ? 0 : Math.sin(a0) * radius;
                const z1 = useY ? 0 : Math.sin(a1) * radius;
                pushLine(
                    ev.x + x0, ev.y + y0, ev.z + z0,
                    ev.x + x1, ev.y + y1, ev.z + z1,
                    r, g, bl
                );
            }
        }

        // ─── 12 radial debris spokes (deterministic 3D pattern) ───
        // Each spoke runs from a small inner radius to a larger outer
        // radius, sweeping outward as the impact ages. φ/θ derive from
        // the spoke index so the pattern stays stable across frames
        // (no shimmer) yet differs per-impact when several overlap.
        const SPOKES = 12;
        const innerR = 0.1;
        const outerR = radius * (ev.kind === 'kill' ? 1.7 : 1.35);
        for (let i = 0; i < SPOKES; i++) {
            const phi   = (i / SPOKES) * Math.PI * 2;
            const theta = ((i * 0.37) % Math.PI); // slowly varying elevation
            const dx = Math.cos(phi) * Math.sin(theta);
            const dy = Math.cos(theta) * (i % 2 ? 1.0 : -0.5); // mix vertical
            const dz = Math.sin(phi) * Math.sin(theta);
            const t0 = 0.15 + 0.85 * t; // inner → outer sweep over the lifetime
            const rI = innerR + (outerR - innerR) * (t0 * 0.5);
            const rO = innerR + (outerR - innerR) * t0;
            pushLine(
                ev.x + dx * rI, ev.y + dy * rI, ev.z + dz * rI,
                ev.x + dx * rO, ev.y + dy * rO, ev.z + dz * rO,
                r, g, bl
            );
        }

        // ─── Core flash (only during the impact's first 40%) ───
        // A 3-axis 3-segment crosshair near the impact point. Kill events
        // get a brighter and longer-lasting flash; regular hits just blink
        // briefly, which still reads as a hit-confirmation pop.
        if (t < 0.4) {
            const flashFade = (1.0 - t / 0.4);
            const flashFrac = ev.kind === 'kill' ? 1.4 : 0.9;
            const f = flashFade * flashFrac;
            const fr = Math.min(1.0, r + f * 0.5);
            const fg = Math.min(1.0, g + f * 0.7);
            const fb = Math.min(1.0, bl + f * 0.9);
            const half = baseR * 0.4;
            pushLine(ev.x - half, ev.y, ev.z, ev.x + half, ev.y, ev.z, fr, fg, fb);
            pushLine(ev.x, ev.y - half, ev.z, ev.x, ev.y + half, ev.z, fr, fg, fb);
            pushLine(ev.x, ev.y, ev.z - half, ev.x, ev.y, ev.z + half, fr, fg, fb);
        }
    }

    if (vCursor === 0 || !_impactStreamVao) return;

    // Single MVP shared across every impact — same trick used by the
    // projectile stream renderer.
    mat4Multiply(proj, view, _tmpMVP);
    gl.bindVertexArray(_impactStreamVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, _impactPosGpu);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, _impactPosBuf.subarray(0, vCursor));
    gl.bindBuffer(gl.ARRAY_BUFFER, _impactColGpu);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, _impactColBuf.subarray(0, vCursor));
    gl.useProgram(_program);
    gl.uniformMatrix4fv(_uMVP, false, _tmpMVP);
    gl.drawArrays(gl.LINES, 0, vCursor / 3);
    gl.bindVertexArray(null);
}
