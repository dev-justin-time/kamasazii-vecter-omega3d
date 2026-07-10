// ─── Radar HUD ──────────────────────────────────────────────────
// Circular tactical radar showing friendly/enemy positions,
// projectiles, range rings, and player orientation. Renders
// to a dedicated canvas element in the HUD overlay.

import { state } from './state.js';
import { ARENA_BOUNDS } from './boundaries.js';

// ─── Configuration ───────────────────────────────────────────
const RADAR_CONFIG = {
    size: 160,           // canvas pixel size
    radius: 74,          // radar circle radius (inner)
    outerRing: 78,       // outer decorative ring
    scale: 4.0,          // world units per pixel (lower = more zoomed)
    ringDistances: [250, 500, 800], // range ring world distances
    bgAlpha: 0.25,
    ringAlpha: 0.15,
};

// ─── Color palette ────────────────────────────────────────────
const COLORS = {
    background:    'rgba(0, 5, 20, 0.85)',
    ring:          'rgba(0, 255, 200, 0.18)',
    ringLabel:     'rgba(0, 255, 200, 0.45)',
    playerBlip:    '#00ff66',
    playerOutline: '#003300',
    enemyBlip:     '#ff4422',
    enemyOutline:  '#330000',
    p2Blip:        '#ff66aa',
    p2Outline:     '#330011',
    projectile:    '#ffff44',
    headingLine:   'rgba(0, 255, 100, 0.6)',
    crosshair:     'rgba(0, 255, 200, 0.25)',
    border:        'rgba(0, 255, 200, 0.3)',
    borderGlow:    'rgba(0, 255, 200, 0.08)',
};

let _canvas = null;
let _ctx = null;
let _initialized = false;

// ─── Pre-allocated draw state (avoid GC in render loop) ──────
const _blipCache = {
    ships: [],
    projectiles: [],
};

/**
 * Initialize the radar canvas. Call once after DOM is ready.
 * @param {string} containerId - ID of the container div (e.g., 'radar-container')
 */
export function initRadar(containerId) {
    const container = document.getElementById(containerId);
    if (!container) {
        console.warn('[RADAR] Container #' + containerId + ' not found');
        return false;
    }

    // Remove any existing canvas
    const existing = container.querySelector('canvas');
    if (existing) existing.remove();

    const size = RADAR_CONFIG.size;
    _canvas = document.createElement('canvas');
    _canvas.id = 'radar-canvas';
    _canvas.width = size;
    _canvas.height = size;
    _canvas.style.cssText = 'display:block;width:' + size + 'px;height:' + size + 'px;';
    container.appendChild(_canvas);

    _ctx = _canvas.getContext('2d');
    _initialized = true;

    console.log('[RADAR] Initialized ' + size + '×' + size);
    return true;
}

/**
 * Update the radar from ship positions and projectiles.
 * Called every frame from the game loop.
 * @param {Array} shipData - Array of {id, x, y, z, transform, health} from engine
 * @param {Array} projectileData - Array of {x, y, z, owner_id, weapon} from engine
 */
export function updateRadar(shipData, projectileData) {
    if (!_initialized || !_ctx) return;

    const ctx = _ctx;
    const size = RADAR_CONFIG.size;
    const cx = size / 2;
    const cy = size / 2;
    const radius = RADAR_CONFIG.radius;
    const scale = RADAR_CONFIG.scale;

    // ─── Clear ───────────────────────────────────────────────
    ctx.clearRect(0, 0, size, size);

    // ─── Background circle ───────────────────────────────────
    ctx.fillStyle = COLORS.background;
    ctx.beginPath();
    ctx.arc(cx, cy, RADAR_CONFIG.outerRing, 0, Math.PI * 2);
    ctx.fill();

    // ─── Outer border glow ──────────────────────────────────
    ctx.strokeStyle = COLORS.borderGlow;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(cx, cy, RADAR_CONFIG.outerRing, 0, Math.PI * 2);
    ctx.stroke();

    // ─── Outer border ───────────────────────────────────────
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, RADAR_CONFIG.outerRing, 0, Math.PI * 2);
    ctx.stroke();

    // ─── Range rings ────────────────────────────────────────
    for (const ringDist of RADAR_CONFIG.ringDistances) {
        const ringRadius = ringDist / scale;
        if (ringRadius > radius) continue;

        ctx.strokeStyle = COLORS.ring;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
        ctx.stroke();

        // Ring label
        ctx.fillStyle = COLORS.ringLabel;
        ctx.font = '9px "Space Mono", monospace';
        ctx.fillText((ringDist) + 'm', cx + ringRadius - 22, cy - ringRadius + 12);
    }

    // ─── Crosshair ──────────────────────────────────────────
    ctx.strokeStyle = COLORS.crosshair;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    // ─── Cardinal direction labels ──────────────────────────
    ctx.fillStyle = COLORS.ringLabel;
    ctx.font = 'bold 10px "Space Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, cy - radius + 10);
    ctx.fillText('S', cx, cy + radius - 6);
    ctx.fillText('E', cx + radius - 10, cy + 4);
    ctx.fillText('W', cx - radius + 10, cy + 4);

    // ─── Find player position for relative mapping ────────────
    let playerX = 0, playerZ = 0;
    let playerTransform = null;
    if (shipData) {
        const p1 = shipData.find(s => s.id === 'player_1');
        if (p1) {
            playerX = p1.x || 0;
            playerZ = p1.z || 0;
            playerTransform = p1.transform || null;
        }
    }

    // ─── Draw ship blips ─────────────────────────────────────
    if (shipData) {
        _blipCache.ships.length = 0;

        for (const ship of shipData) {
            if (ship.id === 'player_1') continue; // player drawn separately

            const dx = ship.x - playerX;
            const dz = ship.z - playerZ;
            const blipX = cx + dx / scale;
            const blipY = cy + dz / scale;

            // Clamp to radar edge (with direction indicator)
            const dist = Math.sqrt(dx * dx + dz * dz) / scale;
            let drawX = blipX, drawY = blipY;
            let onEdge = false;

            if (dist > radius * 0.92 && dist > 0) {
                const angle = Math.atan2(dz, dx);
                drawX = cx + Math.cos(angle) * radius * 0.88;
                drawY = cy + Math.sin(angle) * radius * 0.88;
                onEdge = true;
            }

            _blipCache.ships.push({ ship, drawX, drawY, onEdge, dx: dx / scale, dz: dz / scale });
        }

        // Draw blips (sorted: enemies first, then P2)
        const sorted = _blipCache.ships.sort((a, b) => {
            if (a.ship.id === 'enemy_apex') return -1;
            if (b.ship.id === 'enemy_apex') return 1;
            return 0;
        });

        for (const blip of sorted) {
            const { ship, drawX, drawY, onEdge } = blip;
            const isEnemy = ship.id === 'enemy_apex';
            const isP2 = ship.id === 'player_2';
            const blipColor = isEnemy ? COLORS.enemyBlip : (isP2 ? COLORS.p2Blip : '#888888');
            const outlineColor = isEnemy ? COLORS.enemyOutline : (isP2 ? COLORS.p2Outline : '#111111');
            const blipSize = isEnemy ? 5 : 4;

            // Direction triangle (pointing in ship's facing direction)
            ctx.save();
            ctx.translate(drawX, drawY);

            // Determine facing from transform (column-major: R[6],R[7],R[8] = forward Z)
            let facingAngle = -Math.PI / 2; // default: pointing up
            if (ship.transform && ship.transform.length >= 9) {
                const fx = ship.transform[6]; // forward X
                const fz = ship.transform[8]; // forward Z
                facingAngle = Math.atan2(fz, -fx); // rotate: forward maps to up
            }

            ctx.rotate(facingAngle);

            // Glow
            ctx.shadowColor = blipColor;
            ctx.shadowBlur = onEdge ? 8 : 4;

            // Triangle blip
            ctx.fillStyle = blipColor;
            ctx.beginPath();
            ctx.moveTo(0, -blipSize - 2);      // nose
            ctx.lineTo(-blipSize, blipSize);    // left wing
            ctx.lineTo(blipSize, blipSize);     // right wing
            ctx.closePath();
            ctx.fill();

            // Outline
            ctx.strokeStyle = outlineColor;
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.shadowBlur = 0;
            ctx.restore();

            // Edge pulsing indicator (if ship is beyond radar range)
            if (onEdge) {
                const pulse = 0.5 + Math.sin(performance.now() / 200) * 0.5;
                ctx.fillStyle = blipColor.replace(')', ', ' + pulse.toFixed(2) + ')').replace('rgb', 'rgba');
                ctx.beginPath();
                ctx.arc(drawX, drawY, blipSize + 4, 0, Math.PI * 2);
                ctx.fill();
            }

            // Health bar (tiny, below blip)
            if (ship.health !== undefined) {
                const hp = Math.max(0, Math.min(1, ship.health / 100));
                const barW = 14;
                const barH = 2;
                const barX = drawX - barW / 2;
                const barY = drawY + blipSize + 4;
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                ctx.fillRect(barX, barY, barW, barH);
                ctx.fillStyle = hp > 0.5 ? '#00ff66' : hp > 0.25 ? '#ffaa00' : '#ff2222';
                ctx.fillRect(barX, barY, barW * hp, barH);
            }
        }
    }

    // ─── Player blip (center, always) ────────────────────────
    ctx.save();
    ctx.translate(cx, cy);

    // Player facing from transform
    let pFacing = -Math.PI / 2;
    if (playerTransform && playerTransform.length >= 9) {
        pFacing = Math.atan2(playerTransform[8], -playerTransform[6]);
    }
    ctx.rotate(pFacing);

    // Glow
    ctx.shadowColor = COLORS.playerBlip;
    ctx.shadowBlur = 6;
    ctx.fillStyle = COLORS.playerBlip;
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(-5, 5);
    ctx.lineTo(5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = COLORS.playerOutline;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Heading line (forward direction)
    ctx.strokeStyle = COLORS.headingLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(0, -radius * 0.6);
    ctx.stroke();

    ctx.restore();

    // ─── Projectile blips ────────────────────────────────────
    if (projectileData && projectileData.length > 0) {
        for (const proj of projectileData) {
            if (!proj || proj.owner_id === 'player_1') continue;

            const dx = proj.x - playerX;
            const dz = proj.z - playerZ;
            const dist = Math.sqrt(dx * dx + dz * dz) / scale;

            if (dist > radius * 0.95) continue; // off radar

            const bx = cx + dx / scale;
            const by = cy + dz / scale;

            // Small dot with pulse
            const pulse = 0.4 + Math.sin(performance.now() / 80 + proj.id) * 0.3;
            ctx.fillStyle = COLORS.projectile.replace(')', ', ' + pulse.toFixed(2) + ')').replace('rgb', 'rgba');
            ctx.beginPath();
            ctx.arc(bx, by, 1.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

/**
 * Check if radar is initialized.
 */
export function isRadarReady() {
    return _initialized;
}
