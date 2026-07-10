// ─── Arena Boundaries ────────────────────────────────────────────
// Wireframe boundary walls, kill-zone detection, spawn zones.
// Renders a glowing wireframe box around the combat arena and enforces
// a soft boundary — ships that stray outside take damage over time.

import { gl } from './dom.js';
import { state } from './state.js';
import { ARENA } from './arena.js';
import { mat4Multiply } from './math.js';

// ─── Arena configuration ─────────────────────────────────────
export const ARENA_BOUNDS = {
    halfX: 500,   // ±500 world units
    halfY: 250,   // ±250 vertical
    halfZ: 500,   // ±500 world units
    // Arena floor is at the bottom of the Y range
    floorY: -250,
    ceilingY: 250,
    // Soft boundary: damage/sec when outside
    boundaryDps: 15,
    // Warning zone: distance from edge where HUD flashes
    warningDistance: 80,
};

// ─── Spawn zones ─────────────────────────────────────────────
export const SPAWN_ZONES = {
    player_1:  { x: 0,   y: 0,  z: 0 },
    player_2:  { x: 50,  y: 3,  z: -40 },
    enemy_apex:{ x: -50, y: 6,  z: -40 },
};

// ─── Boundary wall VAO ───────────────────────────────────────
let _boundaryVao = null;
let _boundaryVertCount = 0;
let _boundaryLoaded = false;

/**
 * Build the arena boundary wireframe box VAO.
 * Must be called after WebGL is initialized (ARENA.program is available).
 */
export function initBoundaries() {
    if (!gl || !ARENA.program) return false;

    const { halfX, halfY, halfZ, floorY, ceilingY } = ARENA_BOUNDS;

    // Wireframe box: 12 edges of a cuboid
    const x = halfX, yTop = ceilingY, yBot = floorY, z = halfZ;

    // 8 corners
    const corners = [
        [-x, yBot, -z], [ x, yBot, -z], [ x, yTop, -z], [-x, yTop, -z], // back face
        [-x, yBot,  z], [ x, yBot,  z], [ x, yTop,  z], [-x, yTop,  z], // front face
    ];
    // 12 edges (pairs of corner indices)
    const edges = [
        [0,1],[1,2],[2,3],[3,0], // back face
        [4,5],[5,6],[6,7],[7,4], // front face
        [0,4],[1,5],[2,6],[3,7], // bridges
    ];

    const positions = new Float32Array(edges.length * 6); // 2 verts × 3 floats
    const colors = new Float32Array(edges.length * 6);
    const edgeColor = [0.15, 0.6, 0.15]; // dim green for boundary

    for (let i = 0; i < edges.length; i++) {
        const [a, b] = edges[i];
        const o = i * 6;
        positions[o+0]=corners[a][0]; positions[o+1]=corners[a][1]; positions[o+2]=corners[a][2];
        positions[o+3]=corners[b][0]; positions[o+4]=corners[b][1]; positions[o+5]=corners[b][2];
        colors[o+0]=edgeColor[0]; colors[o+1]=edgeColor[1]; colors[o+2]=edgeColor[2];
        colors[o+3]=edgeColor[0]; colors[o+4]=edgeColor[1]; colors[o+5]=edgeColor[2];
    }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(ARENA.program, 'aPosition');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

    const colBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
    const aCol = gl.getAttribLocation(ARENA.program, 'aColor');
    gl.enableVertexAttribArray(aCol);
    gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);

    _boundaryVao = vao;
    _boundaryVertCount = positions.length / 3;
    _boundaryLoaded = true;

    console.log('[BOUNDARIES] Arena box: ±' + halfX + ' X, Y ' + floorY + '→' + ceilingY + ', ±' + halfZ + ' Z');
    return true;
}

/**
 * Render the boundary wireframe box.
 * @param {Float32Array} view - 4×4 view matrix
 * @param {Float32Array} proj - 4×4 projection matrix
 */
export function renderBoundaries(view, proj) {
    if (!_boundaryLoaded || !ARENA.program) return;
    const mvp = mat4Multiply(proj, view);
    gl.useProgram(ARENA.program);
    gl.uniformMatrix4fv(ARENA.uMVP, false, mvp);
    gl.bindVertexArray(_boundaryVao);
    gl.drawArrays(gl.LINES, 0, _boundaryVertCount);
    gl.bindVertexArray(null);
}

// ─── Boundary enforcement (called from game loop) ────────────

let _boundaryWarningActive = false;
let _warningFlashTimer = 0;
let _outOfBoundsTime = {};  // ship id → accumulated seconds outside
const OOB_KILL_THRESHOLD = 5.0; // seconds outside before hard kill

/**
 * Check if a position is outside the arena bounds.
 * Returns { outOfBounds: bool, distance: number, axis: string }.
 */
export function checkBounds(x, y, z) {
    const { halfX, halfY, halfZ, floorY, ceilingY } = ARENA_BOUNDS;
    let maxViolation = 0;
    let axis = '';

    const violations = {
        x: Math.max(0, Math.abs(x) - halfX),
        yHigh: Math.max(0, y - ceilingY),
        yLow: Math.max(0, floorY - y),
        z: Math.max(0, Math.abs(z) - halfZ),
    };

    for (const [k, v] of Object.entries(violations)) {
        if (v > maxViolation) { maxViolation = v; axis = k; }
    }

    return {
        outOfBounds: maxViolation > 0,
        distance: maxViolation,
        axis,
        violations,
    };
}

/**
 * Enforce arena boundaries on all ships.
 * Accumulates out-of-bounds time — after 5 seconds outside, kills the ship.
 * Damage is applied directly to the synced state.health (after engine sync).
 * Called once per tick from main.js fixedUpdate().
 * @param {Array} shipData - Parsed from engine.get_ship_positions()
 * @param {number} dt - Delta time in seconds
 */
export function enforceBoundaries(shipData, dt) {
    if (!shipData || !Array.isArray(shipData)) return;

    const { boundaryDps, warningDistance } = ARENA_BOUNDS;
    let anyWarning = false;

    for (const ship of shipData) {
        const result = checkBounds(ship.x, ship.y, ship.z);

        if (result.outOfBounds) {
            // Accumulate time spent outside bounds
            _outOfBoundsTime[ship.id] = (_outOfBoundsTime[ship.id] || 0) + dt;

            // Apply damage over time to the synced state (reducing health from
            // whatever the engine reported this tick — boundary damage stacks
            // on top of the engine's health each frame)
            if (ship.id === 'player_1') {
                state.health = Math.max(0, state.health - boundaryDps * dt);
            }
            if (state.gameMode === 'pvp' && ship.id === 'player_2') {
                state.p2.health = Math.max(0, state.p2.health - boundaryDps * dt);
            }

            // Hard kill after threshold
            if (_outOfBoundsTime[ship.id] >= OOB_KILL_THRESHOLD) {
                if (ship.id === 'player_1') state.health = 0;
                if (ship.id === 'player_2') state.p2.health = 0;
            }

            if (ship.id === 'player_1') anyWarning = true;
        } else {
            // Decay out-of-bounds timer when back inside (faster decay)
            _outOfBoundsTime[ship.id] = Math.max(0, (_outOfBoundsTime[ship.id] || 0) - dt * 3);
        }

        // Check warning zone (near boundary but not yet outside)
        if (!result.outOfBounds) {
            const nearBoundary =
                Math.abs(ship.x) > ARENA_BOUNDS.halfX - warningDistance ||
                ship.y > ARENA_BOUNDS.ceilingY - warningDistance ||
                ship.y < ARENA_BOUNDS.floorY + warningDistance ||
                Math.abs(ship.z) > ARENA_BOUNDS.halfZ - warningDistance;

            if (nearBoundary && ship.id === 'player_1') {
                anyWarning = true;
            }
        }
    }

    // Toggle boundary warning HUD element
    _boundaryWarningActive = anyWarning;
}

/**
 * Reset out-of-bounds timers (call on mission restart).
 */
export function resetBoundaryTimers() {
    _outOfBoundsTime = {};
    _boundaryWarningActive = false;
    _warningFlashTimer = 0;
}

/**
 * Update boundary warning HUD (called from game loop).
 * Flashes the boundary warning overlay when the player is near/outside bounds.
 */
export function updateBoundaryWarning(dt) {
    const el = document.getElementById('boundary-warning');
    if (!el) return;

    if (_boundaryWarningActive) {
        _warningFlashTimer += dt;
        const alpha = 0.3 + Math.sin(_warningFlashTimer * 6) * 0.3;
        el.style.opacity = Math.max(0, Math.min(1, alpha));
        el.style.visibility = 'visible';
    } else {
        el.style.opacity = '0';
        el.style.visibility = 'hidden';
        _warningFlashTimer = 0;
    }
}

// Expose for renderer
window.__ARENA_BOUNDS = ARENA_BOUNDS;
