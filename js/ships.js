// ─── GLB Ship Model Loader ────────────────────────────────────
// Loads binary glTF (.glb) ship models, creates WebGL VAOs with
// mutable color buffers for per-team coloring.

import { mat4Identity, mat4Multiply, mat4Translate, mat4FromQuat, mat4Scale } from './math.js';
import { gl } from './dom.js';
import { ARENA } from './arena.js';
import { state } from './state.js';
import { saveLoadout } from './network.js';

// ─── Pre-allocated reusable color buffer (avoid alloc in render) ──
const _tmpCols = new Float32Array(3 * 12000); // up to 12k verts

export const SHIPS = {
    models: {},
    scale: 2.5,
    assignments: {
        player_1: 'f22_raptor',
        player_2: 'corsair_plane',
        enemy_apex: 'helicopter',
    },
    colors: {
        player_1: [0.0, 1.0, 0.4],
        player_2: [1.0, 0.0, 0.6],
        enemy_apex: [1.0, 0.4, 0.0],
    },
    paths: {
        f22_raptor: './assets/f22_raptor.glb',
        corsair_plane: './assets/corsair_plane.glb',
        helicopter: './assets/animated_helicopter.glb',
        bf109: './assets/bf_109_f-2_messerschmitt.glb',
        medical_drone: './assets/critical_medical_drone.glb',
        // `heavy_spaceship` removed — the GLB was missing on disk and the
        // fetch was returning 404 every page load. Re-add the entry below
        // (and drop the asset back into /assets/) when you have a usable
        // heavy bomber model.
    },
    available: [
        { key: 'f22_raptor', name: 'F-22 Raptor', desc: 'Stealth Fighter' },
        { key: 'bf109', name: 'BF-109', desc: 'Axis Fighter' },
        { key: 'corsair_plane', name: 'Corsair', desc: 'Prop Fighter' },
        { key: 'helicopter', name: 'Attack Heli', desc: 'Rotary Wing' },
        { key: 'medical_drone', name: 'Med Drone', desc: 'Support UAV' },
    ],
};

// Current loadout indices
export let loadoutIdx = {
    player_1: 0,
    player_2: 2,
    enemy_apex: 3,
};

export async function loadShipGLB(name, url) {
    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const buf = await resp.arrayBuffer();
        const dv = new DataView(buf);

        if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('Not a GLB');

        let offset = 12;
        const totalLen = dv.getUint32(8, true);
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

        function readAccessor(accIdx) {
            const acc = gltf.accessors[accIdx];
            const bv = gltf.bufferViews[acc.bufferView];
            const bo = (acc.byteOffset || 0) + bv.byteOffset;
            const n = acc.type === 'VEC3' ? 3 : acc.type === 'VEC2' ? 2 : 1;
            return new Float32Array(binData, bo, acc.count * n);
        }

        function readIndices(accIdx) {
            const acc = gltf.accessors[accIdx];
            const bv = gltf.bufferViews[acc.bufferView];
            const bo = (acc.byteOffset || 0) + bv.byteOffset;
            if (acc.componentType === 5123) return new Uint16Array(binData, bo, acc.count);
            return new Uint32Array(binData, bo, acc.count);
        }

        function getNodeMatrix(ni, cache) {
            if (cache[ni]) return cache[ni];
            const node = gltf.nodes[ni];
            let m = mat4Identity();
            if (node.matrix) m = new Float32Array(node.matrix);
            else {
                if (node.translation) m = mat4Translate(m, node.translation[0], node.translation[1], node.translation[2]);
                if (node.rotation) m = mat4FromQuat(m, node.rotation[0], node.rotation[1], node.rotation[2], node.rotation[3]);
                if (node.scale) m = mat4Scale(m, node.scale[0], node.scale[1], node.scale[2]);
            }
            let parent = -1;
            for (let i = 0; i < gltf.nodes.length; i++) {
                if (gltf.nodes[i].children && gltf.nodes[i].children.includes(ni)) { parent = i; break; }
            }
            if (parent >= 0) m = mat4Multiply(getNodeMatrix(parent, cache), m);
            cache[ni] = m;
            return m;
        }

        const matCache = [];
        const allPos = [], allIdx = [];
        let baseVtx = 0;

        for (let i = 0; i < gltf.nodes.length; i++) {
            const wm = getNodeMatrix(i, matCache);
            if (gltf.nodes[i].mesh !== undefined) {
                const meshDef = gltf.meshes[gltf.nodes[i].mesh];
                for (const prim of meshDef.primitives) {
                    const pos = readAccessor(prim.attributes.POSITION);
                    const idx = readIndices(prim.indices);
                    for (let j = 0; j < pos.length; j += 3) {
                        const x=pos[j], y=pos[j+1], z=pos[j+2];
                        allPos.push(x*wm[0]+y*wm[4]+z*wm[8]+wm[12]);
                        allPos.push(x*wm[1]+y*wm[5]+z*wm[9]+wm[13]);
                        allPos.push(x*wm[2]+y*wm[6]+z*wm[10]+wm[14]);
                    }
                    for (let j = 0; j < idx.length; j++) allIdx.push(idx[j] + baseVtx);
                    baseVtx += pos.length / 3;
                }
            }
        }

        if (allPos.length === 0) throw new Error('No mesh data');

        let minX=Infinity, minY=Infinity, minZ=Infinity;
        let maxX=-Infinity, maxY=-Infinity, maxZ=-Infinity;
        for (let j = 0; j < allPos.length; j += 3) {
            if (allPos[j]   < minX) minX = allPos[j];
            if (allPos[j]   > maxX) maxX = allPos[j];
            if (allPos[j+1] < minY) minY = allPos[j+1];
            if (allPos[j+1] > maxY) maxY = allPos[j+1];
            if (allPos[j+2] < minZ) minZ = allPos[j+2];
            if (allPos[j+2] > maxZ) maxZ = allPos[j+2];
        }
        const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
        const diagonal = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
        const unitScale = 8 / diagonal;

        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);

        const posBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(allPos), gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(ARENA.program, 'aPosition');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

        const defCol = new Float32Array(allPos.length);
        for (let i = 0; i < defCol.length; i++) defCol[i] = 0.5;
        const colBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
        gl.bufferData(gl.ARRAY_BUFFER, defCol, gl.DYNAMIC_DRAW);
        const aCol = gl.getAttribLocation(ARENA.program, 'aColor');
        gl.enableVertexAttribArray(aCol);
        gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0);

        const useUint16 = !allIdx.some(i => i > 65535);
        const idxBuf = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,
            useUint16 ? new Uint16Array(allIdx) : new Uint32Array(allIdx),
            gl.STATIC_DRAW);

        gl.bindVertexArray(null);

        const model = { vao, colBuf, vertexCount: allPos.length / 3, indexCount: allIdx.length,
            indexType: useUint16 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT, unitScale };

        SHIPS.models[name] = model;
        console.log('[SHIP] Loaded ' + name + ': ' + model.vertexCount + ' verts, ' + model.indexCount + ' indices, scale=' + unitScale.toFixed(3));
        return model;
    } catch (e) {
        console.warn('[SHIP] Failed to load ' + name + ' from ' + url + ': ' + e.message);
        return null;
    }
}

/**
 * Render a loaded GLB ship model. The model matrix now embeds the ship's
 * actual rotation matrix (`R`, column-major 9-float Float32Array) so the
 * ship visually banks/pitches/yaws with the player input. Identity rotation
 * reproduces the previous hardcoded orientation, so the default case is a
 * drop-in render.
 *
 * Geometry layout (column-major 4×4 mm):
 *   col 0 = R * base_col0 * scale = R * [0, 0, -1]^T * s
 *   col 1 = R * base_col1 * scale = R * [0, 1,  0]^T * s
 *   col 2 = R * base_col2 * scale = R * [1, 0,  0]^T * s
 *   col 3 = pos
 */
export function renderShipModel(model, pos, color, proj, view, rotation) {
    if (!model || !ARENA.program) return;
    const n = model.vertexCount;
    const cols = n * 3 <= _tmpCols.length ? _tmpCols : new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { cols[i*3]=color[0]; cols[i*3+1]=color[1]; cols[i*3+2]=color[2]; }
    gl.bindBuffer(gl.ARRAY_BUFFER, model.colBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, cols, 0, n * 3);

    const s = model.unitScale || 2.5;
    const R = rotation || (new Float32Array([1, 0, 0,  0, 1, 0,  0, 0, 1]));
    // With identity R:
    //   col0 = [-R[6], -R[7], -R[8]] * s = [0, 0, -s]      ✓ legacy
    //   col1 = [ R[3],  R[4],  R[5]] * s = [0, s,  0]      ✓ legacy
    //   col2 = [ R[0],  R[1],  R[2]] * s = [s, 0,  0]      ✓ legacy
    const mm = new Float32Array([
        -R[6]*s, -R[7]*s, -R[8]*s, 0,
         R[3]*s,  R[4]*s,  R[5]*s, 0,
         R[0]*s,  R[1]*s,  R[2]*s, 0,
         pos[0],  pos[1],  pos[2],  1,
    ]);
    const mv = mat4Multiply(view, mm);
    const mvp = mat4Multiply(proj, mv);

    gl.useProgram(ARENA.program);
    gl.uniformMatrix4fv(ARENA.uMVP, false, mvp);
    gl.bindVertexArray(model.vao);
    gl.drawElements(gl.TRIANGLES, model.indexCount, model.indexType, 0);
    gl.bindVertexArray(null);
}

// renderShipModel is exported for use by renderer.js
// (defined above in this file)

export function selectShipLoadout(slot, direction) {
    const avail = SHIPS.available;
    const len = avail.length;
    if (len === 0) return;
    const prevIdx = loadoutIdx[slot];
    const newIdx = ((prevIdx + direction) % len + len) % len;
    loadoutIdx[slot] = newIdx;
    const entry = avail[newIdx];
    SHIPS.assignments[slot] = entry.key;
    const nameEl = document.getElementById('loadout-name-' + slot);
    const descEl = document.getElementById('loadout-desc-' + slot);
    if (nameEl) nameEl.textContent = entry.name;
    if (descEl) descEl.textContent = entry.desc;
    // Debounced persist to Puter KV (500ms after last click)
    if (window.__loadoutSaveTimer) clearTimeout(window.__loadoutSaveTimer);
    window.__loadoutSaveTimer = setTimeout(function() {
        saveLoadout({ player_1: SHIPS.assignments.player_1, player_2: SHIPS.assignments.player_2, mode: state.gameMode });
    }, 500);
}

// Wire loadout arrow buttons
document.querySelectorAll('.loadout-arrow').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var slot = btn.getAttribute('data-slot');
        var dir = btn.classList.contains('loadout-prev') ? -1 : 1;
        selectShipLoadout(slot, dir);
    });
});
