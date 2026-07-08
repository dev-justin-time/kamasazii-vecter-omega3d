// ─── WebGL Wireframe Renderer ────────────────────────────────
// Sets up shaders, VAO, and exposes a render() callback on state.
// Pre-allocates reusable buffers to avoid per-frame GC pressure.

import { mat4Multiply, perspective, lookAt } from './math.js';
import { canvas, gl } from './dom.js';
import { state } from './state.js';
import { ARENA, renderArena } from './arena.js';
import { SHIPS, renderShipModel as _renderShipModel } from './ships.js';

// ─── Pre-allocated reusable temporaries (avoid GC in render loop) ──
const _tmpMVP = new Float32Array(16);
const _tmpAnimView = new Float32Array(16);

let _program, _uMVP, _vao, _vertCount;
let _aPos, _aCol;

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

    _vao = gl.createVertexArray();
    gl.bindVertexArray(_vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.enableVertexAttribArray(_aPos);
    gl.vertexAttribPointer(_aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
    gl.enableVertexAttribArray(_aCol);
    gl.vertexAttribPointer(_aCol, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    _program = program;
    _vertCount = positions.length / 3;

    // Share program + uniform with arena & ships modules
    ARENA.program = program;
    ARENA.uMVP = _uMVP;

    // ─── Wire scene state into the render closure ─────────────
    const scene = { angle: 0, scale: 5 };
    let arenaAnimT = 0;

    function evaluateArenaAnimation(t) {
        return [0, Math.sin(t * 0.3) * 0.5, 0];
    }

    state.render = () => {
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
        let eye, center;
        if (state.running && state.engine) {
            try {
                const shipData = JSON.parse(state.engine.get_ship_positions());
                const p1 = shipData.find(s => s.id === 'player_1');
                if (p1) {
                    center = [p1.x, p1.y, p1.z];
                    eye = [
                        center[0] + Math.sin(scene.angle) * 15,
                        center[1] + 8,
                        center[2] + Math.cos(scene.angle) * 15
                    ];
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

        const view = lookAt(eye, center, [0, 1, 0]);

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

        // ─── Render ships ───────────────────────────────────
        if (state.engine) {
            try {
                const shipData = JSON.parse(state.engine.get_ship_positions());
                for (const ship of shipData) {
                    const isP1 = ship.id === 'player_1';
                    const isP2 = ship.id === 'player_2';
                    const isEnemy = ship.id === 'enemy_apex';
                    if (!isP1 && !isP2 && !isEnemy) continue;
                    if (isP2 && state.gameMode !== 'pvp') continue;

                    const modelName = SHIPS.assignments[ship.id];
                    const model = modelName ? SHIPS.models[modelName] : null;
                    const color = SHIPS.colors[ship.id] || [0.5, 0.5, 0.5];

                    if (model) {
                        if (model.modular && typeof window.__SS_renderModular === 'function') {
                            window.__SS_renderModular(model, [ship.x, ship.y, ship.z], color, proj, view);
                        } else {
                            _renderShipModel(model, [ship.x, ship.y, ship.z], color, proj, view);
                        }
                    } else {
                        // Fallback: wireframe ship silhouette (arrow/wedge shape)
                        const s = 3;
                        const x = ship.x, y = ship.y, z = ship.z;
                        // Wireframe ship: fuselage + wings + tail as line segments
                        const mp = new Float32Array([
                            // Fuselage (diamond)
                            x, y, z+s*1.5,   x+s*0.4, y, z-0.5,
                            x, y, z+s*1.5,   x-s*0.4, y, z-0.5,
                            x+s*0.4, y, z-0.5,  x, y, z-s*1.0,
                            x-s*0.4, y, z-0.5,  x, y, z-s*1.0,
                            // Wings
                            x+s*0.4, y, z-0.5,  x+s*1.5, y, z-s*0.8,
                            x-s*0.4, y, z-0.5,  x-s*1.5, y, z-s*0.8,
                            x+s*1.5, y, z-s*0.8,  x+s*0.4, y, z-s*0.3,
                            x-s*1.5, y, z-s*0.8,  x-s*0.4, y, z-s*0.3,
                            // Tail
                            x, y, z-s*1.0,   x, y+s*0.6, z-s*1.3,
                            x, y+s*0.6, z-s*1.3,  x+s*0.3, y, z-s*0.7,
                            x, y+s*0.6, z-s*1.3,  x-s*0.3, y, z-s*0.7,
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
        }
    };

    return true;
}
