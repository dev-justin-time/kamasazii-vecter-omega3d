// ─── GLTF Arena Loader (90s Vaporwave Neon Grid) ──────────────
// Loads the arena glTF + binary, transforms vertices to world space,
// builds WebGL VAOs, and parses animation keyframes.

import { mat4Identity, mat4Multiply, mat4Translate, mat4FromQuat, mat4Scale } from './math.js';
import { gl } from './dom.js';

export const ARENA = {
    loaded: false,
    meshes: [],
    program: null,
    uMVP: null,
    animTime: 0,
    animDuration: 10,
    animTranslations: null,
    animTimes: null,
};

export async function loadArena() {
    const base = './assets/models/90s_vaporwave_neon_grid_animated (1)/';
    try {
        const gltfResp = await fetch(base + 'scene.gltf');
        const gltf = await gltfResp.json();
        const binResp = await fetch(base + gltf.buffers[0].uri);
        const bin = await binResp.arrayBuffer();

        const matColors = [
            [1.0, 0.5, 1.0],
            [0.01, 0.01, 0.01],
            [0.012, 0.009, 0.04],
            [0.0, 0.997, 1.0],
        ];

        function readAccessor(accIdx) {
            const acc = gltf.accessors[accIdx];
            const bv = gltf.bufferViews[acc.bufferView];
            const byteOff = (acc.byteOffset || 0) + bv.byteOffset;
            const n = acc.type === 'VEC3' ? 3 : acc.type === 'VEC2' ? 2 : acc.type === 'SCALAR' ? 1 :
                      acc.type === 'VEC4' ? 4 : 3;
            return new Float32Array(bin, byteOff, acc.count * n);
        }

        function readIndices(accIdx) {
            const acc = gltf.accessors[accIdx];
            const bv = gltf.bufferViews[acc.bufferView];
            const byteOff = (acc.byteOffset || 0) + bv.byteOffset;
            const stride = bv.byteStride || 4;
            const src = new Uint32Array(bin, byteOff, acc.count * stride / 4);
            if (stride > 4) {
                const r = new Uint32Array(acc.count);
                for (let i = 0; i < acc.count; i++) r[i] = src[i * (stride/4)];
                return r;
            }
            return new Uint32Array(bin, byteOff, acc.count);
        }

        function getNodeWorldMatrix(nodeIdx, cache) {
            if (cache[nodeIdx]) return cache[nodeIdx];
            const node = gltf.nodes[nodeIdx];
            let local = mat4Identity();
            if (node.matrix) {
                local = new Float32Array(node.matrix);
            } else {
                if (node.translation) local = mat4Translate(local, node.translation[0], node.translation[1], node.translation[2]);
                if (node.rotation) local = mat4FromQuat(local, node.rotation[0], node.rotation[1], node.rotation[2], node.rotation[3]);
                if (node.scale) local = mat4Scale(local, node.scale[0], node.scale[1], node.scale[2]);
            }
            let parentIdx = -1;
            for (let i = 0; i < gltf.nodes.length; i++) {
                if (gltf.nodes[i].children && gltf.nodes[i].children.includes(nodeIdx)) {
                    parentIdx = i; break;
                }
            }
            if (parentIdx >= 0) local = mat4Multiply(getNodeWorldMatrix(parentIdx, cache), local);
            cache[nodeIdx] = local;
            return local;
        }

        const nodeMatrices = [];
        const meshEntries = [];
        for (let i = 0; i < gltf.nodes.length; i++) {
            getNodeWorldMatrix(i, nodeMatrices);
            if (gltf.nodes[i].mesh !== undefined) {
                meshEntries.push({ nodeIdx: i, meshIdx: gltf.nodes[i].mesh, worldMtx: nodeMatrices[i] });
            }
        }

        const meshes = [];
        for (const me of meshEntries) {
            const meshDef = gltf.meshes[me.meshIdx];
            for (const prim of meshDef.primitives) {
                const pos = readAccessor(prim.attributes.POSITION);
                const idx = readIndices(prim.indices);
                const matIdx = prim.material !== undefined ? prim.material : 0;
                const col = matColors[matIdx] || [1,1,1];

                const m = me.worldMtx;
                const worldPos = new Float32Array(pos.length);
                for (let i = 0; i < pos.length; i += 3) {
                    const x=pos[i], y=pos[i+1], z=pos[i+2];
                    worldPos[i]   = x*m[0] + y*m[4] + z*m[8] + m[12];
                    worldPos[i+1] = x*m[1] + y*m[5] + z*m[9] + m[13];
                    worldPos[i+2] = x*m[2] + y*m[6] + z*m[10] + m[14];
                }

                const colors = new Float32Array(pos.length);
                for (let i = 0; i < colors.length; i += 3) {
                    colors[i]=col[0]; colors[i+1]=col[1]; colors[i+2]=col[2];
                }

                const vao = gl.createVertexArray();
                gl.bindVertexArray(vao);

                const posBuf = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
                gl.bufferData(gl.ARRAY_BUFFER, worldPos, gl.STATIC_DRAW);
                const aPos = gl.getAttribLocation(ARENA.program, 'aPosition');
                gl.enableVertexAttribArray(aPos);
                gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

                const colBuf = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
                gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
                const aCol = gl.getAttribLocation(ARENA.program, 'aColor');
                gl.enableVertexAttribArray(aCol);
                gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0);

                const idxBuf = gl.createBuffer();
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
                gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

                gl.bindVertexArray(null);
                meshes.push({ vao, indexCount: idx.length, mode: gl.TRIANGLES });
            }
        }

        if (gltf.animations && gltf.animations.length > 0) {
            const anim = gltf.animations[0];
            const smp = anim.samplers[0];
            ARENA.animTimes = readAccessor(smp.input);
            ARENA.animTranslations = readAccessor(smp.output);
            ARENA.animDuration = ARENA.animTimes[ARENA.animTimes.length - 1] || 10;
            console.log('[ARENA] Animation loaded: ' + ARENA.animTimes.length + ' keyframes, ' + ARENA.animDuration.toFixed(1) + 's');
        }

        ARENA.meshes = meshes;
        ARENA.loaded = true;
        console.log('[ARENA] Vaporwave grid loaded: ' + meshes.length + ' primitives, ~' +
            meshes.reduce((s,m)=>s+m.indexCount,0) + ' triangles');
    } catch (e) {
        console.warn('[ARENA] Failed to load vaporwave model:', e);
    }
}

export function renderArena(viewMatrix, projMatrix) {
    if (!ARENA.loaded || !ARENA.program) return;
    const mvp = mat4Multiply(projMatrix, viewMatrix);
    gl.useProgram(ARENA.program);
    gl.uniformMatrix4fv(ARENA.uMVP, false, mvp);
    for (const mesh of ARENA.meshes) {
        gl.bindVertexArray(mesh.vao);
        gl.drawElements(mesh.mode, mesh.indexCount, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
}
