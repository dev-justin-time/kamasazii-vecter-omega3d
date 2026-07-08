// ─── Vector Math Helpers ─────────────────────────────────────────
export function sub3(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
export function add3(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
export function scale3(v, s) { return [v[0]*s, v[1]*s, v[2]*s]; }
export function dot3(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
export function cross3(a, b) {
    return [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
}
export function normalize3(v) {
    const m = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
    return m ? [v[0]/m, v[1]/m, v[2]/m] : v;
}

// ─── 4×4 Matrix Helpers (column-major Float32Array) ─────────────

export function mat4Identity() {
    return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
}

export function mat4Multiply(a, b, out) {
    const r = out || new Float32Array(16);
    for (let i = 0; i < 4; i++)
        for (let j = 0; j < 4; j++)
            r[j*4+i] = a[i]*b[j*4] + a[4+i]*b[j*4+1] + a[8+i]*b[j*4+2] + a[12+i]*b[j*4+3];
    return r;
}

export function mat4Translate(m, tx, ty, tz) {
    const r = new Float32Array(m);
    r[12] += m[0]*tx + m[4]*ty + m[8]*tz;
    r[13] += m[1]*tx + m[5]*ty + m[9]*tz;
    r[14] += m[2]*tx + m[6]*ty + m[10]*tz;
    r[15] += m[3]*tx + m[7]*ty + m[11]*tz;
    return r;
}

export function mat4Scale(m, sx, sy, sz) {
    const r = new Float32Array(m);
    r[0]*=sx; r[1]*=sx; r[2]*=sx; r[3]*=sx;
    r[4]*=sy; r[5]*=sy; r[6]*=sy; r[7]*=sy;
    r[8]*=sz; r[9]*=sz; r[10]*=sz; r[11]*=sz;
    return r;
}

export function mat4FromQuat(m, qx, qy, qz, qw) {
    const xx=qx*qx, yy=qy*qy, zz=qz*qz;
    const xy=qx*qy, xz=qx*qz, yz=qy*qz;
    const wx=qw*qx, wy=qw*qy, wz=qw*qz;
    const r = mat4Identity();
    r[0]=1-2*(yy+zz); r[4]=2*(xy-wz);     r[8]=2*(xz+wy);
    r[1]=2*(xy+wz);   r[5]=1-2*(xx+zz);   r[9]=2*(yz-wx);
    r[2]=2*(xz-wy);   r[6]=2*(yz+wx);     r[10]=1-2*(xx+yy);
    return mat4Multiply(m, r);
}

// ─── Projection / View Matrices ─────────────────────────────────

export function perspective(fov, aspect, near, far) {
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
        f/aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, 2 * far * near * nf, 0
    ]);
}

export function lookAt(eye, center, up) {
    const fwd = normalize3(sub3(center, eye));
    const side = normalize3(cross3(fwd, up));
    const newUp = cross3(side, fwd);
    return new Float32Array([
        side[0], newUp[0], -fwd[0], 0,
        side[1], newUp[1], -fwd[1], 0,
        side[2], newUp[2], -fwd[2], 0,
        -dot3(side, eye), -dot3(newUp, eye), dot3(fwd, eye), 1
    ]);
}
