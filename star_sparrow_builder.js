/* ═══════════════════════════════════════════════════════════════════════════
   STAR SPARROW — Custom Build-Out Module (revised)
   ═══════════════════════════════════════════════════════════════════════════
   Loaded as a regular (<script defer>) script. Reads module-scoped values
   (gl, ARENA, SHIPS, state, engine) from the window.__SS_* slots that
   index.html exposes after each major setup step — necessary because
   <script type="module"> keeps its `const` declarations out of the global
   scope, so a classic-script builder can't see them by name.

   Hydration preference: Puter KV (omni_buildout_v1) → localStorage → preset.
   Apply falls back gracefully when the Wasm engine hasn't mounted yet.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
'use strict';

// ============================================================================
// Shared env accessor — pulls refs from the index.html-exposed window slots.
// Returns nulls for anything not yet mounted; callers must null-check.
// ============================================================================
function env() {
    if (typeof window === 'undefined') return { gl: null, ARENA: null, SHIPS: null, state: null, engine: null };
    return {
        gl:     window.__SS_gl     || null,
        ARENA:  window.__SS_ARENA  || null,
        SHIPS:  window.__SS_SHIPS  || null,
        state:  window.__SS_state  || null,
        engine: window.__SS_engine || (window.__SS_state && window.__SS_state.engine) || null,
    };
}

// ============================================================================
// 1. CATALOG — mirrors the GLB structure (32 meshes, 8 categories)
// ============================================================================
const STARSPARROW = {
    model: 'star_sparrow_modular',
    parts: [
        // THRUSTERS (5) — rear (z=-55.53)
        { id: 'thruster_outer_l', cat: 'thruster', name: 'Outer Thruster L', mesh: 0,  verts: 102 },
        { id: 'thruster_outer_r', cat: 'thruster', name: 'Outer Thruster R', mesh: 1,  verts: 102 },
        { id: 'thruster_inner_l', cat: 'thruster', name: 'Inner Thruster L', mesh: 8,  verts: 175 },
        { id: 'thruster_inner_r', cat: 'thruster', name: 'Inner Thruster R', mesh: 14, verts: 175 },
        { id: 'thruster_core',    cat: 'thruster', name: 'Core Thruster',    mesh: 13, verts: 175 },
        // ENGINES (2) — z=-50.66
        { id: 'engine_l', cat: 'engine', name: 'Engine Cowling L', mesh: 7,  verts: 126 },
        { id: 'engine_r', cat: 'engine', name: 'Engine Cowling R', mesh: 12, verts: 126 },
        // WINGS (2) — z=-42.70 (mesh 10 sits at x=+2.52 → right; mesh 11 at x=-2.58 → left)
        { id: 'wing_l', cat: 'wing', name: 'Wing L', mesh: 11, verts: 110 },
        { id: 'wing_r', cat: 'wing', name: 'Wing R', mesh: 10, verts: 110 },
        // FINS (4) — z=-36.51
        { id: 'fin_a', cat: 'fin', name: 'Fin A', mesh: 28, verts: 24 },
        { id: 'fin_b', cat: 'fin', name: 'Fin B', mesh: 29, verts: 24 },
        { id: 'fin_c', cat: 'fin', name: 'Fin C', mesh: 30, verts: 24 },
        { id: 'fin_d', cat: 'fin', name: 'Fin D', mesh: 31, verts: 24 },
        // TAILS (6) — z=-31.98
        { id: 'tail_a', cat: 'tail', name: 'Tail Spire A', mesh: 4,  verts: 24 },
        { id: 'tail_b', cat: 'tail', name: 'Tail Spire B', mesh: 15, verts: 24 },
        { id: 'tail_c', cat: 'tail', name: 'Tail Spire C', mesh: 16, verts: 24 },
        { id: 'tail_d', cat: 'tail', name: 'Tail Spire D', mesh: 17, verts: 24 },
        { id: 'tail_e', cat: 'tail', name: 'Tail Spire E', mesh: 18, verts: 24 },
        { id: 'tail_f', cat: 'tail', name: 'Tail Spire F', mesh: 19, verts: 24 },
        // PLASMA (2) — z=-7.75
        { id: 'plasma_l', cat: 'plasma', name: 'Plasma Conduit L', mesh: 5, verts: 166 },
        { id: 'plasma_r', cat: 'plasma', name: 'Plasma Conduit R', mesh: 9, verts: 166 },
        // CORE (1) — required, never deselectable
        { id: 'core', cat: 'core', name: 'Core Hull', mesh: 6, verts: 626, required: true },
        // FORWARD CANNONS (8) — z=0
        { id: 'cannon_r1', cat: 'weapon', name: 'Cannon R1', mesh: 21, verts: 86 },
        { id: 'cannon_r2', cat: 'weapon', name: 'Cannon R2', mesh: 23, verts: 86 },
        { id: 'cannon_r3', cat: 'weapon', name: 'Cannon R3', mesh: 20, verts: 86 },
        { id: 'cannon_r4', cat: 'weapon', name: 'Cannon R4', mesh: 22, verts: 86 },
        { id: 'cannon_l1', cat: 'weapon', name: 'Cannon L1', mesh: 27, verts: 86 },
        { id: 'cannon_l2', cat: 'weapon', name: 'Cannon L2', mesh: 26, verts: 86 },
        { id: 'cannon_l3', cat: 'weapon', name: 'Cannon L3', mesh: 25, verts: 86 },
        { id: 'cannon_l4', cat: 'weapon', name: 'Cannon L4', mesh: 24, verts: 86 },
        // HEAVY CANNONS (2) — z≈0
        { id: 'heavy_l', cat: 'weapon', name: 'Heavy Cannon L', mesh: 2, verts: 79 },
        { id: 'heavy_r', cat: 'weapon', name: 'Heavy Cannon R', mesh: 3, verts: 79 },
    ],
    // colorSlot maps category → theme color slot.
    categories: [
        { id: 'core',     label: 'Core Hull',    colorSlot: 'primary'   },
        { id: 'wing',     label: 'Wings',        colorSlot: 'primary'   },
        { id: 'engine',   label: 'Engines',      colorSlot: 'secondary' },
        { id: 'thruster', label: 'Thrusters',    colorSlot: 'glow'      },
        { id: 'fin',      label: 'Aft Fins',     colorSlot: 'secondary' },
        { id: 'tail',     label: 'Tail Spires',  colorSlot: 'secondary' },
        { id: 'plasma',   label: 'Plasma Coils', colorSlot: 'glow'      },
        { id: 'weapon',   label: 'Weapons',      colorSlot: 'accent'    },
    ],
    byId(id) { return this.parts.find(p => p.id === id); },
    partsInCategory(catId) { return this.parts.filter(p => p.cat === catId); },
};

// ============================================================================
// 2. PRESETS / 3. THEMES (unchanged from previous revision)
// ============================================================================
const STARSPARROW_PRESETS = {
    balanced: { label: 'Balanced', desc: 'All systems nominal', parts: 'ALL' },
    fighter:  { label: 'Fighter',  desc: 'Max guns, light hull',
                parts: ['core','wing_l','wing_r','engine_l','engine_r','thruster_outer_l','thruster_outer_r','heavy_l','heavy_r','cannon_r1','cannon_r2','cannon_l1','cannon_l2'] },
    cruiser:  { label: 'Cruiser',  desc: 'Heavy thrust, few guns',
                parts: ['core','wing_l','wing_r','engine_l','engine_r','thruster_outer_l','thruster_outer_r','thruster_inner_l','thruster_inner_r','thruster_core','fin_a','fin_b','fin_c','fin_d','cannon_r1','cannon_l1'] },
    bomber:   { label: 'Bomber',   desc: 'Max firepower',
                parts: ['core','wing_l','wing_r','engine_l','engine_r','thruster_outer_l','thruster_outer_r','thruster_inner_l','thruster_inner_r','heavy_l','heavy_r','cannon_r1','cannon_r2','cannon_r3','cannon_r4','cannon_l1','cannon_l2','cannon_l3','cannon_l4','tail_a','tail_b','tail_c'] },
    stealth:  { label: 'Stealth',  desc: 'Slim profile',
                parts: ['core','wing_l','wing_r','engine_l','engine_r','thruster_outer_l','thruster_outer_r','cannon_l1','cannon_r1'] },
};
const STARSPARROW_THEMES = [
    { id: 'cyan',    label: 'Cyan Aurora',    primary: [1.00,1.00,1.00], secondary: [0.40,0.80,1.00], accent: [0.20,1.00,0.40], glow: [0.10,0.80,1.00] },
    { id: 'crimson', label: 'Crimson Fang',   primary: [1.00,0.60,0.60], secondary: [1.00,0.30,0.30], accent: [1.00,0.15,0.10], glow: [1.00,0.35,0.05] },
    { id: 'void',    label: 'Void Black',     primary: [0.45,0.45,0.55], secondary: [0.20,0.20,0.30], accent: [0.60,0.10,0.90], glow: [0.40,0.10,1.00] },
    { id: 'gold',    label: 'Gold Sovereign', primary: [1.00,0.85,0.40], secondary: [0.85,0.65,0.20], accent: [0.80,0.30,0.00], glow: [1.00,0.70,0.10] },
    { id: 'emerald', label: 'Emerald Hunter', primary: [0.70,1.00,0.85], secondary: [0.30,0.90,0.50], accent: [0.05,1.00,0.40], glow: [0.10,0.95,0.40] },
];
const STARSPARROW_THEMES_BY_ID = {};
STARSPARROW_THEMES.forEach(function (t) { STARSPARROW_THEMES_BY_ID[t.id] = t; });

// ============================================================================
// 4. BUILDOUT — runtime state
// ============================================================================
const BUILDOUT = {
    enabledParts: new Set(),
    currentTheme: 'cyan',
    currentPreset: 'balanced',
    activeBuildName: null,
    savedBuilds: {},
    computeStats() {
        const parts = STARSPARROW.parts.filter(p => this.enabledParts.has(p.id));
        const cntOf = cat => parts.filter(p => p.cat === cat).length;
        const totalVerts = parts.reduce((s, p) => s + p.verts, 0);
        const mass = Math.max(0.5, totalVerts / 2200);
        const thrust_mult = 1 + cntOf('thruster') * 0.18 + cntOf('engine') * 0.10;
        const drag = Math.min(0.999, 0.9995 - mass * 0.0006);
        const finAuthority = cntOf('fin') * 0.04;
        const angular_drag = Math.max(0.86, 0.98 + (mass - 1) * 0.02 - finAuthority);
        const cannonIds = parts.filter(p => p.id.startsWith('cannon')).length;
        const heavyIds  = parts.filter(p => p.id.startsWith('heavy')).length;
        const weaponDPS = cannonIds * 0.5 + heavyIds * 1.2;
        return {
            mass:          +mass.toFixed(2),
            thrust_mult:   +thrust_mult.toFixed(2),
            drag:          +drag.toFixed(4),
            angular_drag:  +angular_drag.toFixed(4),
            weaponDPS:     +weaponDPS.toFixed(1),
            enabledCount:  parts.length,
            thrusterCount: cntOf('thruster'),
            engineCount:   cntOf('engine'),
            wingCount:     cntOf('wing'),
            finCount:      cntOf('fin'),
            tailCount:     cntOf('tail'),
            cannonCount:   cannonIds,
            heavyCount:    heavyIds,
            plasmaCount:   cntOf('plasma'),
        };
    },

    /**
     * Per-shot multipliers derived from the current build. Consumed by the
     * JS fire loop in index.html via window.__SS_weaponMults — each shot
     * reads the cached object and scales energy / heat / cooldown.
     *
     *   Stealth (1 cannon, no heavies): high cadence, low heat — fast & cheap.
     *   Cruiser  (2 cannons, no heavies): moderate cadence — efficient.
     *   Bomber   (8 cannons + 2 heavies): harder hits, more heat, slower cycle.
     *
     * Why these numbers? Each cannon is +4% damage / +2% heat / +2% energy
     * with a -3% cooldown bonus. Heavy cannons amplify damage by +25% but
     * also add +20% heat and +10% cooldown (they're punishing per shot).
     */
    computeWeaponModifiers() {
        const parts = STARSPARROW.parts.filter(function (p) { return this.enabledParts.has(p.id); });
        const cannonIds = parts.filter(function (p) { return p.id.startsWith('cannon'); }).length;
        const heavyIds  = parts.filter(function (p) { return p.id.startsWith('heavy');  }).length;
        const thrustMult = 1 + parts.filter(function (p) { return p.cat === 'thruster'; }).length * 0.18
                          + parts.filter(function (p) { return p.cat === 'engine';   }).length * 0.10;

        // Damage: scaling from cannon count + heavy cannon density.
        const damageMult   = 1 + cannonIds * 0.04 + heavyIds * 0.25;
        // Cooldown: more cannons rotate faster, but heavies are slow & punishing.
        const cooldownMult = Math.max(0.40, 1 - cannonIds * 0.03 + heavyIds * 0.10);
        // Heat: heavies generate a lot; cannons are modest.
        const heatMult     = 1 + cannonIds * 0.02 + heavyIds * 0.20;
        // Energy per shot: scaling per weapon, heavies again are costly.
        const energyMult   = 1 + cannonIds * 0.02 + heavyIds * 0.06;
        // Projectile speed: tied to thrust multiplier (more engines → faster rounds).
        const speedMult    = 0.85 + thrustMult * 0.07;

        return {
            damageMult:   +damageMult.toFixed(3),
            cooldownMult: +cooldownMult.toFixed(3),
            heatMult:     +heatMult.toFixed(3),
            energyMult:   +energyMult.toFixed(3),
            speedMult:    +speedMult.toFixed(3),
        };
    },
};

// ============================================================================
// 5. REGISTER WITH SHIPS — polled until SHIPS is exposed on window.
// ============================================================================
function registerShipEntry() {
    const _env = env();
    if (!_env.SHIPS) {
        // Try again on next animation frame (SHIPS exposes happen progressively)
        requestAnimationFrame(registerShipEntry);
        return;
    }
    if (!_env.SHIPS.paths.star_sparrow_modular) {
        _env.SHIPS.paths.star_sparrow_modular =
            './assets/star-sparrow-modular-spaceship (1).glb';
        if (!_env.SHIPS.available.some(function (s) { return s.key === 'star_sparrow_modular'; })) {
            _env.SHIPS.available.push({
                key:  'star_sparrow_modular',
                name: 'Star Sparrow',
                desc: 'Modular Build',
            });
        }
        console.log('[SS] Registered ship in SHIPS catalog');
    }
}

// ============================================================================
// 6. loadModularShip — per-part VAOs (one GLB mesh → one VAO + per-vertex color)
// ============================================================================
function _ssMat4Identity() { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); }
function _ssMat4Multiply(a, b) {
    const r = new Float32Array(16);
    for (let i = 0; i < 4; i++)
        for (let j = 0; j < 4; j++)
            r[j*4+i] = a[i]*b[j*4] + a[4+i]*b[j*4+1] + a[8+i]*b[j*4+2] + a[12+i]*b[j*4+3];
    return r;
}
function _ssMat4Translate(m, tx, ty, tz) {
    const r = new Float32Array(m);
    r[12] += m[0]*tx + m[4]*ty + m[8]*tz;
    r[13] += m[1]*tx + m[5]*ty + m[9]*tz;
    r[14] += m[2]*tx + m[6]*ty + m[10]*tz;
    r[15] += m[3]*tx + m[7]*ty + m[11]*tz;
    return r;
}
function _ssMat4FromQuat(m, qx, qy, qz, qw) {
    const xx=qx*qx, yy=qy*qy, zz=qz*zz;
    const xy=qx*qy, xz=qx*qz, yz=qy*qz;
    const wx=qw*qx, wy=qw*qy, wz=qw*qz;
    const r = _ssMat4Identity();
    r[0]=1-2*(yy+zz); r[4]=2*(xy-wz);     r[8]=2*(xz+wy);
    r[1]=2*(xy+wz);   r[5]=1-2*(xx+zz);   r[9]=2*(yz-wx);
    r[2]=2*(xz-wy);   r[6]=2*(yz+wx);     r[10]=1-2*(xx+yy);
    return _ssMat4Multiply(m, r);
}
function _ssMat4Scale(m, sx, sy, sz) {
    const r = new Float32Array(m);
    r[0]*=sx; r[1]*=sx; r[2]*=sx; r[3]*=sx;
    r[4]*=sy; r[5]*=sy; r[6]*=sy; r[7]*=sy;
    r[8]*=sz; r[9]*=sz; r[10]*=sz; r[11]*=sz;
    return r;
}

async function loadModularShip(name, url) {
    const _env = env();
    const gl = _env.gl;
    if (!gl || !_env.ARENA || !_env.ARENA.program) {
        console.warn('[SS] WebGL/ARENA not ready — deferring modular load');
        requestAnimationFrame(function () { loadModularShip(name, url); });
        return null;
    }
    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const buf = await resp.arrayBuffer();
        const dv = new DataView(buf);
        if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('Not a GLB');
        let offset = 12, totalLen = dv.getUint32(8, true);
        let gltf = null, binData = null;
        while (offset < totalLen) {
            const chunkLen = dv.getUint32(offset, true);
            const chunkType = dv.getUint32(offset + 4, true);
            offset += 8;
            const chunk = buf.slice(offset, offset + chunkLen);
            if (chunkType === 0x4E4F534A) gltf = JSON.parse(new TextDecoder().decode(chunk));
            else if (chunkType === 0x004E4942) binData = chunk;
            offset += chunkLen;
        }
        if (!gltf || !binData) throw new Error('Missing chunks');

        function readAcc(accIdx) {
            const acc = gltf.accessors[accIdx];
            const bv = gltf.bufferViews[acc.bufferView];
            const bo = (acc.byteOffset || 0) + bv.byteOffset;
            const n = acc.type === 'VEC3' ? 3 : acc.type === 'VEC2' ? 2 : 1;
            return new Float32Array(binData, bo, acc.count * n);
        }
        function readIdx(accIdx) {
            const acc = gltf.accessors[accIdx];
            const bv = gltf.bufferViews[acc.bufferView];
            const bo = (acc.byteOffset || 0) + bv.byteOffset;
            if (acc.componentType === 5123) return new Uint16Array(binData, bo, acc.count);
            return new Uint32Array(binData, bo, acc.count);
        }
        function getNodeMatrix(ni, cache) {
            if (cache[ni]) return cache[ni];
            const node = gltf.nodes[ni];
            let m = _ssMat4Identity();
            if (node.matrix) m = new Float32Array(node.matrix);
            else {
                if (node.translation) m = _ssMat4Translate(m, node.translation[0], node.translation[1], node.translation[2]);
                if (node.rotation)    m = _ssMat4FromQuat  (m, node.rotation[0], node.rotation[1], node.rotation[2], node.rotation[3]);
                if (node.scale)       m = _ssMat4Scale     (m, node.scale[0], node.scale[1], node.scale[2]);
            }
            let parent = -1;
            for (let i = 0; i < gltf.nodes.length; i++) {
                if (gltf.nodes[i].children && gltf.nodes[i].children.includes(ni)) {
                    parent = i; break;
                }
            }
            if (parent >= 0) m = _ssMat4Multiply(getNodeMatrix(parent, cache), m);
            cache[ni] = m;
            return m;
        }

        const prog = _env.ARENA.program;
        const matCache = [];
        const partsByMesh = {};
        let minX=Infinity, minY=Infinity, minZ=Infinity;
        let maxX=-Infinity, maxY=-Infinity, maxZ=-Infinity;

        for (let i = 0; i < gltf.nodes.length; i++) {
            if (gltf.nodes[i].mesh === undefined) continue;
            const wm = getNodeMatrix(i, matCache);
            const meshDef = gltf.meshes[gltf.nodes[i].mesh];
            for (let pIdx = 0; pIdx < meshDef.primitives.length; pIdx++) {
                const prim = meshDef.primitives[pIdx];
                const pos = readAcc(prim.attributes.POSITION);
                const idx = readIdx(prim.indices);
                const worldPos = new Float32Array(pos.length);
                for (let v = 0; v < pos.length; v += 3) {
                    const x=pos[v], y=pos[v+1], z=pos[v+2];
                    worldPos[v]   = x*wm[0] + y*wm[4] + z*wm[8] + wm[12];
                    worldPos[v+1] = x*wm[1] + y*wm[5] + z*wm[9] + wm[13];
                    worldPos[v+2] = x*wm[2] + y*wm[6] + z*wm[10] + wm[14];
                    if (worldPos[v]   < minX) minX = worldPos[v];
                    if (worldPos[v]   > maxX) maxX = worldPos[v];
                    if (worldPos[v+1] < minY) minY = worldPos[v+1];
                    if (worldPos[v+1] > maxY) maxY = worldPos[v+1];
                    if (worldPos[v+2] < minZ) minZ = worldPos[v+2];
                    if (worldPos[v+2] > maxZ) maxZ = worldPos[v+2];
                }
                const vertCount = pos.length / 3;
                const cols = new Float32Array(pos.length);
                const useUint16 = !idx.some(function(v) { return v > 65535; });

                const vao = gl.createVertexArray();
                gl.bindVertexArray(vao);
                const posBuf = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
                gl.bufferData(gl.ARRAY_BUFFER, worldPos, gl.STATIC_DRAW);
                const aPos = gl.getAttribLocation(prog, 'aPosition');
                gl.enableVertexAttribArray(aPos);
                gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

                const colBuf = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
                gl.bufferData(gl.ARRAY_BUFFER, cols, gl.DYNAMIC_DRAW);
                const aCol = gl.getAttribLocation(prog, 'aColor');
                gl.enableVertexAttribArray(aCol);
                gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0);

                const idxBuf = gl.createBuffer();
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
                gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,
                    useUint16 ? new Uint16Array(idx) : new Uint32Array(idx), gl.STATIC_DRAW);
                gl.bindVertexArray(null);

                partsByMesh[gltf.nodes[i].mesh + '_' + pIdx] = {
                    vao, colBuf,
                    vertexCount: vertCount,
                    indexCount:  idx.length,
                    indexType:   useUint16 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT,
                    partId:      null,
                    partCat:     null,
                    defaultCol:  cols,
                };
            }
        }

        const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
        const diag = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
        const unitScale = 8 / diag;

        const meshToParts = {};
        STARSPARROW.parts.forEach(function (p) { meshToParts[p.mesh] = p; });
        const partsArr = [];
        for (const key in partsByMesh) {
            const meshIdx = parseInt(key.split('_')[0], 10);
            const part = meshToParts[meshIdx] || null;
            const obj = partsByMesh[key];
            obj.partId = part ? part.id : null;
            obj.partCat = part ? part.cat : null;
            if (part && STARSPARROW.byId(part.id)) partsArr.push(obj);
        }

        const model = { modular: true, unitScale: unitScale, parts: partsArr, totalParts: partsArr.length };
        if (_env.SHIPS) _env.SHIPS.models[name] = model;
        console.log('[SS] Loaded Star Sparrow modular: ' + partsArr.length + ' part VAOs (unitScale=' + unitScale.toFixed(3) + ')');
        return model;
    } catch (e) {
        console.warn('[SS] loadModularShip failed:', e.message);
        return null;
    }
}

// ============================================================================
// 7. renderModularShip — per-part drawElements, skipping disabled parts
// ============================================================================
function renderModularShip(model, pos, baseColor, proj, view) {
    const _env = env();
    if (!model || !model.modular || !model.parts) return;
    const gl = _env.gl, ARENA = _env.ARENA;
    if (!gl || !ARENA || !ARENA.program || !ARENA.uMVP) return;

    const theme = STARSPARROW_THEMES_BY_ID[BUILDOUT.currentTheme] || STARSPARROW_THEMES[0];
    const s = model.unitScale || 0.01;

    const modelMtx = new Float32Array([
        0, 0, -s, 0,
        0, s,  0, 0,
        s, 0,  0, 0,
        pos[0], pos[1], pos[2], 1,
    ]);
    const mv  = _ssMat4Multiply(view, modelMtx);
    const mvp = _ssMat4Multiply(proj, mv);

    gl.useProgram(ARENA.program);
    gl.uniformMatrix4fv(ARENA.uMVP, false, mvp);

    for (let i = 0; i < model.parts.length; i++) {
        const part = model.parts[i];
        if (!part.partId) continue;
        if (!BUILDOUT.enabledParts.has(part.partId)) continue;
        const cat = STARSPARROW.categories.find(function (c) { return c.id === part.partCat; });
        const slot = cat ? cat.colorSlot : 'primary';
        const col = theme[slot] || theme.primary;
        const n = part.vertexCount;
        for (let v = 0; v < n; v++) {
            part.defaultCol[v*3]   = col[0];
            part.defaultCol[v*3+1] = col[1];
            part.defaultCol[v*3+2] = col[2];
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, part.colBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, part.defaultCol);
        gl.bindVertexArray(part.vao);
        gl.drawElements(gl.TRIANGLES, part.indexCount, part.indexType, 0);
    }
    gl.bindVertexArray(null);
}
window.__SS_renderModular = renderModularShip;

// ============================================================================
// 8. UI — dynamically build the customize button + modal in the DOM
// ============================================================================
function _esc(s) {
    return String(s).replace(/[&<>"']/g, function (m) {
        return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[m];
    });
}

function buildCustomizeButton() {
    if (document.getElementById('ss-customize-btn')) return;
    const slot = document.querySelector('.loadout-slot[data-slot="player_1"]');
    if (!slot) return;
    const btn = document.createElement('button');
    btn.id = 'ss-customize-btn';
    btn.className = 'ss-customize-btn';
    btn.type = 'button';
    btn.innerHTML = '<span class="ss-cb-gear">⚙</span><span class="ss-cb-label">BUILD</span>';
    btn.title = 'Customize Star Sparrow parts, themes, and save/load builds';
    btn.addEventListener('click', function (e) { e.stopPropagation(); openCustomizeModal(); });
    const slotsContainer = slot.parentElement;
    if (slotsContainer) {
        slotsContainer.parentElement.insertBefore(btn, slotsContainer.nextSibling);
    }
}

function buildCustomizeModal() {
    if (document.getElementById('ss-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'ss-modal';
    modal.className = 'ss-modal hidden';
    modal.innerHTML = `
        <div class="ss-backdrop"></div>
        <div class="ss-panel">
            <div class="ss-head">
                <div class="ss-title">
                    <span class="ss-title-main">STAR SPARROW</span>
                    <span class="ss-title-sub">// MODULAR BUILD-OUT</span>
                </div>
                <button class="ss-close" id="ss-close-btn" type="button" aria-label="Close">✕</button>
            </div>
            <div class="ss-note" id="ss-note">Toggle parts or whole groups. Stats update live. Saved builds persist via Puter KV + localStorage.</div>
            <div class="ss-preview">
                <canvas id="ss-preview-canvas"></canvas>
                <div class="ss-preview-meta" id="ss-preview-meta">INITIALIZING PREVIEW…</div>
            </div>
            <div class="ss-body">
                <div class="ss-col ss-col-left">
                    <div class="ss-section">
                        <div class="ss-section-label">PRESETS</div>
                        <div class="ss-preset-row" id="ss-preset-row"></div>
                    </div>
                    <div class="ss-section">
                        <div class="ss-section-label">PARTS LIBRARY</div>
                        <div class="ss-parts-container" id="ss-parts-container"></div>
                    </div>
                </div>
                <div class="ss-col ss-col-right">
                    <div class="ss-section">
                        <div class="ss-section-label">COLOR THEME</div>
                        <div class="ss-themes-row" id="ss-themes-row"></div>
                        <div class="ss-theme-name" id="ss-theme-name">Cyan Aurora</div>
                    </div>
                    <div class="ss-section">
                        <div class="ss-section-label">BUILD STATS</div>
                        <div class="ss-stats-grid">
                            <div class="ss-stat"><div class="ss-stat-label">MASS</div><div class="ss-stat-val" id="ss-stat-mass">1.00</div></div>
                            <div class="ss-stat"><div class="ss-stat-label">THRUST</div><div class="ss-stat-val" id="ss-stat-thrust">1.00</div></div>
                            <div class="ss-stat"><div class="ss-stat-label">DRAG</div><div class="ss-stat-val" id="ss-stat-drag">0.9995</div></div>
                            <div class="ss-stat"><div class="ss-stat-label">AGILITY</div><div class="ss-stat-val" id="ss-stat-agility">0.98</div></div>
                            <div class="ss-stat"><div class="ss-stat-label">WEAPONS</div><div class="ss-stat-val" id="ss-stat-weapons">0.0</div></div>
                            <div class="ss-stat"><div class="ss-stat-label">PARTS</div><div class="ss-stat-val" id="ss-stat-parts">0/32</div></div>
                        </div>
                        <div class="ss-stats-row">
                            <span>Thr<span id="ss-stat-thrusters">0</span></span>
                            <span>Eng<span id="ss-stat-engines">0</span></span>
                            <span>Can<span id="ss-stat-cannons">0</span></span>
                            <span>Hvy<span id="ss-stat-heavies">0</span></span>
                            <span>Fin<span id="ss-stat-fins">0</span></span>
                            <span>Tai<span id="ss-stat-tails">0</span></span>
                        </div>
                    </div>
                    <div class="ss-section">
                        <div class="ss-section-label">NAMED BUILDS</div>
                        <div class="ss-save-row">
                            <input type="text" id="ss-build-name" placeholder="Build name…" maxlength="32"/>
                            <button class="ss-btn ss-btn-primary" id="ss-save-btn" type="button">SAVE</button>
                        </div>
                        <div class="ss-build-list" id="ss-build-list"></div>
                    </div>
                    <div class="ss-current">
                        <span class="ss-current-label">CURRENT</span>
                        <span class="ss-current-name" id="ss-current-name">— Custom —</span>
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const closeBtn = modal.querySelector('#ss-close-btn');
    const backdrop = modal.querySelector('.ss-backdrop');
    function _close() { modal.classList.add('hidden'); }
    if (closeBtn) closeBtn.addEventListener('click', _close);
    if (backdrop) backdrop.addEventListener('click', _close);
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) _close();
    });

    const presetRow = modal.querySelector('#ss-preset-row');
    Object.keys(STARSPARROW_PRESETS).forEach(function (key) {
        const p = STARSPARROW_PRESETS[key];
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ss-preset-btn';
        b.setAttribute('data-preset', key);
        b.innerHTML = '<span class="ss-preset-name">' + _esc(p.label) + '</span><span class="ss-preset-desc">' + _esc(p.desc) + '</span>';
        b.addEventListener('click', function () { loadPresetIntoBuildout(key); });
        presetRow.appendChild(b);
    });

    const partsContainer = modal.querySelector('#ss-parts-container');
    STARSPARROW.categories.forEach(function (cat) {
        const partsInCat = STARSPARROW.partsInCategory(cat.id);
        if (partsInCat.length === 0) return;
        const row = document.createElement('div');
        row.className = 'ss-cat'; row.id = 'ss-cat-' + cat.id;
        const theme = STARSPARROW_THEMES_BY_ID[BUILDOUT.currentTheme] || STARSPARROW_THEMES[0];
        const catCol = theme[cat.colorSlot];
        const colRGB = Math.round(catCol[0]*255) + ',' + Math.round(catCol[1]*255) + ',' + Math.round(catCol[2]*255);
        row.innerHTML =
            '<div class="ss-cat-head">' +
                '<label class="ss-cat-toggle-wrap">' +
                    '<input type="checkbox" class="ss-cat-toggle" data-cat="' + cat.id + '" checked/> ' +
                    '<span class="ss-cat-label">' + _esc(cat.label) + '</span>' +
                    '<span class="ss-cat-dot" style="background:rgb(' + colRGB + ')"></span>' +
                '</label>' +
                '<span class="ss-cat-count" data-cat-count="' + cat.id + '">' + partsInCat.length + '/' + partsInCat.length + '</span>' +
            '</div>' +
            '<div class="ss-cat-list"></div>';
        const list = row.querySelector('.ss-cat-list');
        partsInCat.forEach(function (p) {
            const tr = document.createElement('label');
            tr.className = 'ss-part-row' + (p.required ? ' ss-part-required' : '');
            tr.innerHTML =
                '<input type="checkbox" class="ss-part-toggle" data-part="' + p.id + '" ' +
                    (p.required ? 'disabled checked' : 'checked') + '/>' +
                '<span class="ss-part-name">' + _esc(p.name) + '</span>' +
                (p.required ? '<span class="ss-part-tag">REQ</span>' : '');
            list.appendChild(tr);
        });
        partsContainer.appendChild(row);

        list.querySelectorAll('.ss-part-toggle').forEach(function (input) {
            input.addEventListener('change', function () {
                const pid = input.getAttribute('data-part');
                const part = STARSPARROW.byId(pid);
                if (!part || part.required) return;
                toggleBuildPart(pid, input.checked);
            });
        });
        row.querySelector('.ss-cat-toggle').addEventListener('change', function (e) {
            const catId = e.target.getAttribute('data-cat');
            const on = e.target.checked;
            STARSPARROW.partsInCategory(catId).filter(function (p) { return !p.required; }).forEach(function (p) {
                if (on) BUILDOUT.enabledParts.add(p.id);
                else    BUILDOUT.enabledParts.delete(p.id);
            });
            BUILDOUT.currentPreset = 'custom';
            BUILDOUT.activeBuildName = null;
            refreshBuilderUI();
            applyBuildToGame();
        });
    });

    const themeRow = modal.querySelector('#ss-themes-row');
    STARSPARROW_THEMES.forEach(function (t) {
        const s = document.createElement('button');
        s.type = 'button'; s.className = 'ss-theme-swatch';
        s.setAttribute('data-theme', t.id); s.title = t.label;
        const rgb1 = Math.round(t.primary[0]*255) + ',' + Math.round(t.primary[1]*255) + ',' + Math.round(t.primary[2]*255);
        const rgb2 = Math.round(t.secondary[0]*255) + ',' + Math.round(t.secondary[1]*255) + ',' + Math.round(t.secondary[2]*255);
        const rgb3 = Math.round(t.glow[0]*255) + ',' + Math.round(t.glow[1]*255) + ',' + Math.round(t.glow[2]*255);
        s.style.background = 'linear-gradient(135deg, rgb(' + rgb1 + ') 0%, rgb(' + rgb2 + ') 50%, rgb(' + rgb3 + ') 100%)';
        s.addEventListener('click', function () { applyThemeToBuildout(t.id); });
        themeRow.appendChild(s);
    });

    const saveBtn = modal.querySelector('#ss-save-btn');
    const nameInput = modal.querySelector('#ss-build-name');
    if (saveBtn) saveBtn.addEventListener('click', handleSaveBuild);
    if (nameInput) nameInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); handleSaveBuild(); }
    });
}

function openCustomizeModal() {
    const modal = document.getElementById('ss-modal');
    if (!modal) return;
    refreshBuilderUI();
    refreshBuildListUI();
    modal.classList.remove('hidden');
    // Start (or resume) the dedicated WebGL2 preview render loop inside the
    // modal canvas. The live context reads BUILDOUT.enabledParts each frame
    // so user toggles are reflected without explicit sync calls.
    const canvas = modal.querySelector('#ss-preview-canvas');
    if (canvas) openPreview(canvas);
}
function closeCustomizeModal() {
    const modal = document.getElementById('ss-modal');
    if (modal) modal.classList.add('hidden');
    // Tear down the preview context so we don't burn GPU while modal is hidden.
    stopPreview();
}

// ============================================================================
// 9. STATE MUTATIONS + PERSISTENCE (now hydrates from Puter KV too)
// ============================================================================
function loadPresetIntoBuildout(presetKey) {
    const preset = STARSPARROW_PRESETS[presetKey];
    if (!preset) return;
    BUILDOUT.enabledParts = new Set();
    if (preset.parts === 'ALL') {
        STARSPARROW.parts.forEach(function (p) { BUILDOUT.enabledParts.add(p.id); });
    } else {
        preset.parts.forEach(function (id) { BUILDOUT.enabledParts.add(id); });
    }
    BUILDOUT.enabledParts.add('core');
    BUILDOUT.currentPreset = presetKey;
    BUILDOUT.activeBuildName = null;
    refreshBuilderUI();
    applyBuildToGame();
}

function toggleBuildPart(partId, on) {
    const part = STARSPARROW.byId(partId);
    if (!part || part.required) return;
    if (on) BUILDOUT.enabledParts.add(partId);
    else    BUILDOUT.enabledParts.delete(partId);
    BUILDOUT.currentPreset = 'custom';
    BUILDOUT.activeBuildName = null;
    refreshBuilderUI();
    applyBuildToGame();
}

function applyThemeToBuildout(themeId) {
    if (!STARSPARROW_THEMES_BY_ID[themeId]) return;
    BUILDOUT.currentTheme = themeId;
    refreshBuilderUI();
}

function handleSaveBuild() {
    const input = document.getElementById('ss-build-name');
    if (!input) return;
    const name = (input.value || '').trim() || 'Build ' + (Object.keys(BUILDOUT.savedBuilds).length + 1);
    BUILDOUT.savedBuilds[name] = {
        enabled: Array.from(BUILDOUT.enabledParts),
        theme:   BUILDOUT.currentTheme,
    };
    BUILDOUT.activeBuildName = name;
    input.value = '';
    refreshBuildListUI();
    refreshBuilderUI();
    persistBuilds();
}

function handleLoadNamedBuild(name) {
    const b = BUILDOUT.savedBuilds[name];
    if (!b) return;
    BUILDOUT.enabledParts = new Set(b.enabled || []);
    BUILDOUT.currentTheme = b.theme || 'cyan';
    BUILDOUT.activeBuildName = name;
    BUILDOUT.currentPreset = 'custom';
    refreshBuilderUI();
    refreshBuildListUI();
    applyBuildToGame();
}

function handleDeleteNamedBuild(name) {
    delete BUILDOUT.savedBuilds[name];
    if (BUILDOUT.activeBuildName === name) BUILDOUT.activeBuildName = null;
    refreshBuildListUI();
    refreshBuilderUI();
    persistBuilds();
}

function refreshBuilderUI() {
    const setText = function (id, val) {
        const el = document.getElementById(id); if (el) el.textContent = val;
    };
    STARSPARROW.categories.forEach(function (cat) {
        const row = document.getElementById('ss-cat-' + cat.id);
        if (!row) return;
        const parts = STARSPARROW.partsInCategory(cat.id);
        const enabled = parts.filter(function (p) { return BUILDOUT.enabledParts.has(p.id); });
        const total = parts.length;
        const catToggle = row.querySelector('.ss-cat-toggle');
        if (catToggle) catToggle.checked = enabled.length > 0;
        const counter = row.querySelector('[data-cat-count="' + cat.id + '"]');
        if (counter) counter.textContent = enabled.length + '/' + total;
        row.classList.toggle('ss-cat-empty', enabled.length === 0 && total > 0);
        parts.forEach(function (p) {
            const input = row.querySelector('.ss-part-toggle[data-part="' + p.id + '"]');
            if (input && !input.disabled) input.checked = BUILDOUT.enabledParts.has(p.id);
        });
    });
    const s = BUILDOUT.computeStats();
    setText('ss-stat-mass',    s.mass);
    setText('ss-stat-thrust',  s.thrust_mult);
    setText('ss-stat-drag',    s.drag);
    setText('ss-stat-agility', s.angular_drag);
    setText('ss-stat-weapons', s.weaponDPS);
    setText('ss-stat-parts',   s.enabledCount + '/' + STARSPARROW.parts.length);
    setText('ss-stat-thrusters', s.thrusterCount);
    setText('ss-stat-engines',   s.engineCount);
    setText('ss-stat-cannons',   s.cannonCount);
    setText('ss-stat-heavies',   s.heavyCount);
    setText('ss-stat-fins',      s.finCount);
    setText('ss-stat-tails',     s.tailCount);
    document.querySelectorAll('.ss-preset-btn').forEach(function (b) {
        b.classList.toggle('ss-preset-active', b.getAttribute('data-preset') === BUILDOUT.currentPreset);
    });
    document.querySelectorAll('.ss-theme-swatch').forEach(function (s) {
        s.classList.toggle('ss-theme-active', s.getAttribute('data-theme') === BUILDOUT.currentTheme);
    });
    const theme = STARSPARROW_THEMES_BY_ID[BUILDOUT.currentTheme];
    setText('ss-theme-name', theme ? theme.label : BUILDOUT.currentTheme);
    setText('ss-current-name', BUILDOUT.activeBuildName || '— Custom —');
    // Update the preview-meta overlay ("LIVE PREVIEW · 18 / 32 PARTS") so
    // the user can see live count without hovering the canvas.
    refreshPreviewMeta();
}

function refreshBuildListUI() {
    const list = document.getElementById('ss-build-list');
    if (!list) return;
    list.innerHTML = '';
    const names = Object.keys(BUILDOUT.savedBuilds);
    if (names.length === 0) {
        list.innerHTML = '<div class="ss-build-empty">No saved builds yet. Configure parts then SAVE.</div>';
        return;
    }
    names.forEach(function (name) {
        const isActive = name === BUILDOUT.activeBuildName;
        const row = document.createElement('div');
        row.className = 'ss-build-row' + (isActive ? ' ss-build-active' : '');
        row.innerHTML =
            '<span class="ss-build-name">' + _esc(name) + '</span>' +
            '<div class="ss-build-actions">' +
                '<button class="ss-build-load" data-name="' + _esc(name) + '" type="button">LOAD</button>' +
                '<button class="ss-build-del"  data-name="' + _esc(name) + '" type="button" title="Delete">✕</button>' +
            '</div>';
        list.appendChild(row);
    });
    list.querySelectorAll('.ss-build-load').forEach(function (b) {
        b.addEventListener('click', function () { handleLoadNamedBuild(b.getAttribute('data-name')); });
    });
    list.querySelectorAll('.ss-build-del').forEach(function (b) {
        b.addEventListener('click', function () { handleDeleteNamedBuild(b.getAttribute('data-name')); });
    });
}

function buildPayload() {
    return {
        active:  BUILDOUT.activeBuildName,
        current: {
            enabled: Array.from(BUILDOUT.enabledParts),
            theme:   BUILDOUT.currentTheme,
            preset:  BUILDOUT.currentPreset,
        },
        builds:  BUILDOUT.savedBuilds,
    };
}

function persistBuilds() {
    try {
        const json = JSON.stringify(buildPayload());
        localStorage.setItem('omni_buildout_v1', json);
        if (typeof puter !== 'undefined' && puter && puter.kv) {
            puter.kv.set('omni_buildout_v1', json).catch(function (e) {
                console.warn('[SS] Puter KV save error:', e);
            });
        }
    } catch (e) {
        console.warn('[SS] persist failed:', e);
    }
}

async function hydrateBuilds() {
    // 1) Try Puter KV first (only if Puter is online)
    try {
        if (typeof puter !== 'undefined' && puter && puter.kv && puter.auth && puter.auth.isSignedIn && puter.auth.isSignedIn()) {
            const remote = await puter.kv.get('omni_buildout_v1');
            if (remote) {
                // Sync cloud value to localStorage so offline boot is consistent
                try { localStorage.setItem('omni_buildout_v1', typeof remote === 'string' ? remote : JSON.stringify(remote)); } catch (_) {}
                applyPayload(JSON.parse(remote));
                console.log('[SS] Hydrated from Puter KV');
                return;
            }
        }
    } catch (e) {
        console.warn('[SS] Puter hydrate failed, falling back to local:', e);
    }
    // 2) Fall back to localStorage
    try {
        const raw = localStorage.getItem('omni_buildout_v1');
        if (raw) {
            applyPayload(JSON.parse(raw));
            console.log('[SS] Hydrated from localStorage');
            return;
        }
    } catch (e) {
        console.warn('[SS] localStorage hydrate failed:', e);
    }
    // 3) Fall back to default preset
    loadPresetIntoBuildout(BUILDOUT.currentPreset);
}

function applyPayload(payload) {
    if (!payload) return;
    if (payload.builds) BUILDOUT.savedBuilds = payload.builds;
    if (payload.current && Array.isArray(payload.current.enabled) && payload.current.enabled.length) {
        BUILDOUT.enabledParts = new Set(payload.current.enabled);
        BUILDOUT.currentTheme = payload.current.theme || 'cyan';
        BUILDOUT.currentPreset = payload.current.preset || 'custom';
        BUILDOUT.activeBuildName = payload.active || null;
    } else {
        loadPresetIntoBuildout(BUILDOUT.currentPreset);
    }
}

function applyBuildToGame() {
    const _env = env();
    const stats = BUILDOUT.computeStats();
    // Refresh live weapon modifiers so the JS fire loop in index.html scales
    // per-shot energy / heat / cooldown by the current cannon + heavy count.
    // Static object form (not a function) — every applyBuildToGame path
    // (preset load, part toggle, named-build load, mount retry) calls this
    // function, so the cache is always fresh when fixedUpdate fires.
    window.__SS_weaponMults = BUILDOUT.computeWeaponModifiers();
    const eng = _env.engine || (_env.state && _env.state.engine);
    if (eng && typeof eng.set_ship_stats === 'function') {
        try {
            eng.set_ship_stats('player_1', stats.mass, stats.thrust_mult, stats.drag, stats.angular_drag);
        } catch (e) {
            console.warn('[SS] set_ship_stats failed:', e);
        }
    }
    persistBuilds();
}

// ============================================================================
// 10. INIT — wire UI, register ship, prime state, then load the model
// ============================================================================
async function initStarSparrowBuilder() {
    buildCustomizeButton();
    buildCustomizeModal();
    await hydrateBuilds();
    refreshBuilderUI();
    refreshBuildListUI();
    const _env = env();
    if (_env.SHIPS) {
        await loadModularShip('star_sparrow_modular',
            './assets/star-sparrow-modular-spaceship (1).glb');
        applyBuildToGame();
    }
    // Re-apply build whenever the Wasm engine is mounted (catches late init())
    let attempts = 0;
    const tryApply = function () {
        attempts++;
        if (env().engine || (env().state && env().state.engine)) {
            applyBuildToGame();
        } else if (attempts < 30) {
            setTimeout(tryApply, 250);
        }
    };
    setTimeout(tryApply, 250);
    console.log('[SS] Build-out module ready');
}

window.__SS = {
    catalog:    STARSPARROW,
    presets:    STARSPARROW_PRESETS,
    themes:     STARSPARROW_THEMES,
    state:      BUILDOUT,
    loadPreset: loadPresetIntoBuildout,
    refresh:    refreshBuilderUI,
    open:       openCustomizeModal,
    close:      closeCustomizeModal,
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initStarSparrowBuilder);
} else {
    // Defer one tick so the main module has a chance to expose __SS_* slots
    setTimeout(initStarSparrowBuilder, 0);
}

// Kick off the SHIPS-registration poll immediately so the modular ship
// appears in the loadout arrows as soon as it's available.
registerShipEntry();

// ============================================================================
// 11. MODAL PREVIEW PANE — dedicated WebGL2 context for live 3D preview
// ============================================================================
// Renders the current build in a small canvas at the top of the modal. Opens
// its OWN WebGL2 context (cannot share buffers/main-gl state across canvases
// per spec) so the cost is roughly +3MB while the modal is open. Loop stops
// when the modal hides (avoid burning CPU in the background).
// ------------------------------------------------------------------------
// Vector + matrix helpers (only used by the preview renderer — kept tiny)
// ------------------------------------------------------------------------
function _ssSub3(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function _ssDot3(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function _ssCross3(a, b) {
    return [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
}
function _ssNorm3(v) {
    const m = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
    return m ? [v[0]/m, v[1]/m, v[2]/m] : v;
}

let __preview = null;  // singleton preview state { gl, program, model, angle, ... }

// Cheap GLB-parsing helper (mirror of loadModularShip's path reader).
function _ssParseGLB(buf) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('Not a GLB');
    let offset = 12, totalLen = dv.getUint32(8, true);
    let gltf = null, binData = null;
    while (offset < totalLen) {
        const chunkLen  = dv.getUint32(offset, true);
        const chunkType = dv.getUint32(offset + 4, true);
        offset += 8;
        const chunk = buf.slice(offset, offset + chunkLen);
        if      (chunkType === 0x4E4F534A) gltf    = JSON.parse(new TextDecoder().decode(chunk));
        else if (chunkType === 0x004E4942) binData = chunk;
        offset += chunkLen;
    }
    if (!gltf || !binData) throw new Error('Missing chunks');
    return { gltf: gltf, binData: binData };
}

function _ssPreviewCompileShader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn('[SS] Preview shader compile:', gl.getShaderInfoLog(s));
        gl.deleteShader(s);
        return null;
    }
    return s;
}

// Builds per-part VAOs in the preview's WebGL2 context so the GLB can be
// rendered selectively. Returns { parts, unitScale } sized to a smaller fit
// than the in-game scale since the preview canvas is smaller.
function _ssPreviewBuildParts(gl, program, gltf, binData) {
    function readAcc(accIdx) {
        const acc = gltf.accessors[accIdx];
        const bv  = gltf.bufferViews[acc.bufferView];
        const bo  = (acc.byteOffset || 0) + bv.byteOffset;
        const n   = acc.type === 'VEC3' ? 3 : acc.type === 'VEC2' ? 2 : 1;
        return new Float32Array(binData, bo, acc.count * n);
    }
    function readIdx(accIdx) {
        const acc = gltf.accessors[accIdx];
        const bv  = gltf.bufferViews[acc.bufferView];
        const bo  = (acc.byteOffset || 0) + bv.byteOffset;
        if (acc.componentType === 5123) return new Uint16Array(binData, bo, acc.count);
        return new Uint32Array(binData, bo, acc.count);
    }
    function getNodeMatrix(ni, cache) {
        if (cache[ni]) return cache[ni];
        const node = gltf.nodes[ni];
        let m = _ssMat4Identity();
        if (node.matrix) m = new Float32Array(node.matrix);
        else {
            if (node.translation) m = _ssMat4Translate(m, node.translation[0], node.translation[1], node.translation[2]);
            if (node.rotation)    m = _ssMat4FromQuat  (m, node.rotation[0], node.rotation[1], node.rotation[2], node.rotation[3]);
            if (node.scale)       m = _ssMat4Scale     (m, node.scale[0], node.scale[1], node.scale[2]);
        }
        let parent = -1;
        for (let i = 0; i < gltf.nodes.length; i++) {
            if (gltf.nodes[i].children && gltf.nodes[i].children.includes(ni)) {
                parent = i; break;
            }
        }
        if (parent >= 0) m = _ssMat4Multiply(getNodeMatrix(parent, cache), m);
        cache[ni] = m;
        return m;
    }

    const meshToParts = {};
    STARSPARROW.parts.forEach(function (p) { meshToParts[p.mesh] = p; });
    const matCache = [];
    const partsArr = [];
    let minX=Infinity, minY=Infinity, minZ=Infinity;
    let maxX=-Infinity, maxY=-Infinity, maxZ=-Infinity;

    for (let i = 0; i < gltf.nodes.length; i++) {
        if (gltf.nodes[i].mesh === undefined) continue;
        const wm = getNodeMatrix(i, matCache);
        const meshDef = gltf.meshes[gltf.nodes[i].mesh];
        for (let pIdx = 0; pIdx < meshDef.primitives.length; pIdx++) {
            const prim = meshDef.primitives[pIdx];
            const pos = readAcc(prim.attributes.POSITION);
            const idx = readIdx(prim.indices);
            const worldPos = new Float32Array(pos.length);
            for (let v = 0; v < pos.length; v += 3) {
                const x=pos[v], y=pos[v+1], z=pos[v+2];
                worldPos[v]   = x*wm[0] + y*wm[4] + z*wm[8] + wm[12];
                worldPos[v+1] = x*wm[1] + y*wm[5] + z*wm[9] + wm[13];
                worldPos[v+2] = x*wm[2] + y*wm[6] + z*wm[10] + wm[14];
                if (worldPos[v]   < minX) minX = worldPos[v];
                if (worldPos[v]   > maxX) maxX = worldPos[v];
                if (worldPos[v+1] < minY) minY = worldPos[v+1];
                if (worldPos[v+1] > maxY) maxY = worldPos[v+1];
                if (worldPos[v+2] < minZ) minZ = worldPos[v+2];
                if (worldPos[v+2] > maxZ) maxZ = worldPos[v+2];
            }
            const vertCount = pos.length / 3;
            const cols = new Float32Array(pos.length);
            const useUint16 = !idx.some(function(v) { return v > 65535; });

            const vao = gl.createVertexArray();
            gl.bindVertexArray(vao);
            const posBuf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
            gl.bufferData(gl.ARRAY_BUFFER, worldPos, gl.STATIC_DRAW);
            const aPos = gl.getAttribLocation(program, 'aPosition');
            gl.enableVertexAttribArray(aPos);
            gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
            const colBuf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
            gl.bufferData(gl.ARRAY_BUFFER, cols, gl.DYNAMIC_DRAW);
            const aCol = gl.getAttribLocation(program, 'aColor');
            gl.enableVertexAttribArray(aCol);
            gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0);
            const idxBuf = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,
                useUint16 ? new Uint16Array(idx) : new Uint32Array(idx), gl.STATIC_DRAW);
            gl.bindVertexArray(null);

            const meshIdx = gltf.nodes[i].mesh;
            const cat = meshToParts[meshIdx];
            partsArr.push({
                partId: cat ? cat.id : null,
                partCat: cat ? cat.cat : null,
                vao, colBuf,
                vertexCount: vertCount,
                indexCount:  idx.length,
                indexType:   useUint16 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT,
                defaultCol:  cols,
            });
        }
    }
    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
    const diag = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
    // Smaller fit than the in-game TARGET_SIZE=8 since the preview viewport
    // is ~200px tall — keeps the ship pleasantly framed.
    const unitScale = 3.5 / diag;
    return { parts: partsArr, unitScale: unitScale };
}

async function openPreview(canvas) {
    if (__preview) return;  // already running
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: false });
    if (!gl) {
        const meta = canvas.parentElement && canvas.parentElement.querySelector('.ss-preview-meta');
        if (meta) meta.textContent = 'WEBGL2 NOT AVAILABLE';
        return;
    }
    const vsSrc = '#version 300 es\n'
        + 'in vec3 aPosition;\n'
        + 'in vec3 aColor;\n'
        + 'uniform mat4 uMVP;\n'
        + 'out vec3 vColor;\n'
        + 'void main() { gl_Position = uMVP * vec4(aPosition, 1.0); vColor = aColor; gl_PointSize = 2.0; }';
    const fsSrc = '#version 300 es\n'
        + 'precision highp float;\n'
        + 'in vec3 vColor;\n'
        + 'out vec4 fragColor;\n'
        + 'void main() { fragColor = vec4(vColor, 1.0); }';
    const vs = _ssPreviewCompileShader(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = _ssPreviewCompileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return;
    const program = gl.createProgram();
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.warn('[SS] Preview program link failed');
        return;
    }
    gl.useProgram(program);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.0, 0.0, 0.04, 1.0);

    __preview = {
        gl: gl, program: program,
        uMVP: gl.getUniformLocation(program, 'uMVP'),
        model: null, // populated async after GLB parse
        angle: 0,
        running: true,
        rafId: 0,
        canvas: canvas,
    };

    // Auto-rotate orbit camera around the origin. We DON'T translate the
    // model — the ship sits at world-space origin and the camera orbits it.
    const renderOnce = function () {
        const self = __preview;
        if (!self) return;
        const c = self.canvas;
        const W = c.clientWidth || c.width || 600;
        const H = c.clientHeight || c.height || 220;
        if (c.width !== W) c.width = W;
        if (c.height !== H) c.height = H;
        gl.viewport(0, 0, c.width, c.height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (!self.model || !self.model.parts) return;

        const aspect = c.width / c.height || 1;
        const fov = Math.PI / 3.5;
        const tanF = Math.tan(fov / 2);
        // Column-major perspective.
        const proj = new Float32Array([
            1.0 / (aspect * tanF), 0,                     0,                          0,
            0,                     1.0 / tanF,            0,                          0,
            0,                     0,                    -1.001,                     -1,
            0,                     0,                    -0.2002,                     0,
        ]);

        self.angle += 0.0085;
        const camDist = 4.5;
        const eye = [
            Math.sin(self.angle) * camDist,
            2.2 + Math.sin(self.angle * 0.6) * 0.5,
            Math.cos(self.angle) * camDist,
        ];
        const center = [0, 0, 0];
        const up = [0, 1, 0];
        const fwd  = _ssNorm3(_ssSub3(center, eye));  // toward target
        const side = _ssNorm3(_ssCross3(fwd, up));
        const newUp = _ssCross3(side, fwd);
        const view = new Float32Array([
            side[0],  newUp[0], -fwd[0], 0,
            side[1],  newUp[1], -fwd[1], 0,
            side[2],  newUp[2], -fwd[2], 0,
            -_ssDot3(side, eye), -_ssDot3(newUp, eye), _ssDot3(fwd, eye), 1,
        ]);

        const s = self.model.unitScale;
        // Same axis-swap orientation as the main renderer so Z faces up
        // (GLB root rotates 90°; we mirror it here for the preview).
        const modelMtx = new Float32Array([
            0, 0, -s,        0,
            0, s,  0,        0,
            s, 0,  0,        0,
            0, 0,  0,        1,
        ]);
        const mv  = _ssMat4Multiply(view, modelMtx);
        const mvp = _ssMat4Multiply(proj, mv);
        gl.useProgram(self.program);
        gl.uniformMatrix4fv(self.uMVP, false, mvp);

        const theme = STARSPARROW_THEMES_BY_ID[BUILDOUT.currentTheme] || STARSPARROW_THEMES[0];
        for (let p = 0; p < self.model.parts.length; p++) {
            const part = self.model.parts[p];
            if (!part.partId) continue;
            if (!BUILDOUT.enabledParts.has(part.partId)) continue;
            const cat = STARSPARROW.categories.find(function (c) { return c.id === part.partCat; });
            const slot = cat ? cat.colorSlot : 'primary';
            const col = theme[slot] || theme.primary;
            const n = part.vertexCount;
            for (let i = 0; i < n; i++) {
                part.defaultCol[i*3]   = col[0];
                part.defaultCol[i*3+1] = col[1];
                part.defaultCol[i*3+2] = col[2];
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, part.colBuf);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, part.defaultCol);
            gl.bindVertexArray(part.vao);
            gl.drawElements(gl.TRIANGLES, part.indexCount, part.indexType, 0);
        }
        gl.bindVertexArray(null);
    };
    const tick = function () {
        if (!__preview || !__preview.running) return;
        renderOnce();
        __preview.rafId = requestAnimationFrame(tick);
    };
    tick();

    // Async GLB load and upload to the preview context. We could share the
    // main context's parsed data, but a separate fetch keeps the preview
    // independent of the main render loop's load timing.
    try {
        const resp = await fetch('./assets/star-sparrow-modular-spaceship (1).glb');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const buf = await resp.arrayBuffer();
        const parsed = _ssParseGLB(buf);
        const built = _ssPreviewBuildParts(__preview.gl, __preview.program, parsed.gltf, parsed.binData);
        __preview.model = { modular: true, unitScale: built.unitScale, parts: built.parts };
        refreshPreviewMeta();
    } catch (e) {
        console.warn('[SS] Preview GLB load failed:', e);
        const meta = canvas.parentElement && canvas.parentElement.querySelector('.ss-preview-meta');
        if (meta) meta.textContent = 'PREVIEW LOAD FAILED';
    }
}

function stopPreview() {
    if (!__preview) return;
    __preview.running = false;
    if (__preview.rafId) cancelAnimationFrame(__preview.rafId);
    __preview.rafId = 0;
    try {
        const gl = __preview.gl;
        if (__preview.model) {
            for (let i = 0; i < __preview.model.parts.length; i++) {
                if (__preview.model.parts[i].vao) gl.deleteVertexArray(__preview.model.parts[i].vao);
            }
        }
        if (__preview.program) gl.deleteProgram(__preview.program);
    } catch (e) { /* context may already be lost */ }
    __preview = null;
}

function refreshPreviewMeta() {
    const meta = document.getElementById('ss-preview-meta');
    if (!meta) return;
    if (!__preview || !__preview.model) {
        meta.textContent = 'INITIALIZING PREVIEW…';
        return;
    }
    const enabledCount = STARSPARROW.parts.filter(function (p) { return BUILDOUT.enabledParts.has(p.id); }).length;
    const theme = STARSPARROW_THEMES_BY_ID[BUILDOUT.currentTheme];
    meta.textContent = 'LIVE PREVIEW · ' + enabledCount + ' / ' + STARSPARROW.parts.length + ' PARTS · ' +
        (theme ? theme.label.toUpperCase() : BUILDOUT.currentTheme.toUpperCase());
}

})();
