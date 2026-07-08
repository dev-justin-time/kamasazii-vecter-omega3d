// ─── Input System ─────────────────────────────────────────────
// Keyboard (P1 + P2), touch/pointer drag-to-aim, virtual joystick,
// and dedicated fire button.  All input state lives here and is
// consumed by main.js in fixedUpdate().

import { canvas } from './dom.js';
import { state } from './state.js';
import { cycleWeapon, selectWeaponByIndex } from './weapon-select.js';

// ─── Keyboard ────────────────────────────────────────────────
export const keys = {};

document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    keys[k] = true;

    if (e.key === 'Tab') {
        e.preventDefault();
        cycleWeapon(e.shiftKey ? -1 : 1);
        return;
    }

    const num = parseInt(e.key);
    if (num >= 1 && num <= state.availableWeapons.length) {
        selectWeaponByIndex(num - 1);
    }
});

document.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

// ─── Player 2 input (PvP: Arrow Keys + Enter) ───────────────
export function getPlayer2Input() {
    if (state.gameMode !== 'pvp') return { pitch: 0, yaw: 0, roll: 0, throttle: 0, fire: false };
    const pitch = (keys['arrowup'] ? -0.5 : 0) + (keys['arrowdown'] ? 0.5 : 0);
    const yaw = (keys['arrowleft'] ? -0.5 : 0) + (keys['arrowright'] ? 0.5 : 0);
    return { pitch, yaw, roll: 0, throttle: pitch !== 0 ? 0.8 : 0, fire: !!keys['enter'] };
}

// ─── Touch / Pointer Input ───────────────────────────────────
export const pointer = {
    active: false,
    startX: 0, startY: 0,
    x: 0, y: 0,
    startTime: 0,
    tapped: false,
    firePressed: false,
};

// ─── Virtual Joystick ────────────────────────────────────────
const joystickBase = document.getElementById('joystick-base');
const joystickThumb = document.getElementById('joystick-thumb');
const JOYSTICK_CLAMP = 35;
// Cache coarse-pointer check (static per session)
const _isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;

function showJoystick(sx, sy) {
    if (!joystickBase || !joystickThumb) return;
    joystickBase.style.left = sx + 'px';
    joystickBase.style.top = sy + 'px';
    joystickBase.className = 'joystick-visible';
    joystickThumb.style.transform = 'translate(0, 0)';
}

function moveJoystickThumb(cx, cy, sx, sy) {
    if (!joystickThumb) return;
    const dx = cx - sx;
    const dy = cy - sy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > JOYSTICK_CLAMP) {
        const s = JOYSTICK_CLAMP / dist;
        joystickThumb.style.transform = 'translate(' + (dx * s) + 'px, ' + (dy * s) + 'px)';
    } else {
        joystickThumb.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
    }
}

function hideJoystick() {
    if (!joystickBase) return;
    joystickBase.className = 'joystick-hidden';
    if (joystickThumb) joystickThumb.style.transform = 'translate(0, 0)';
}

// ─── Pointer event handlers ──────────────────────────────────
function onPointerDown(e) {
    e.preventDefault();
    pointer.active = true;
    pointer.startX = e.clientX;
    pointer.startY = e.clientY;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.startTime = performance.now();
    pointer.tapped = false;
    canvas.setPointerCapture(e.pointerId);
    if (_isCoarsePointer) showJoystick(e.clientX, e.clientY);
}

function onPointerMove(e) {
    if (!pointer.active) return;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    if (_isCoarsePointer) moveJoystickThumb(e.clientX, e.clientY, pointer.startX, pointer.startY);
}

function onPointerUp(e) {
    e.preventDefault();
    const held = performance.now() - pointer.startTime;
    const dx = Math.abs(e.clientX - pointer.startX);
    const dy = Math.abs(e.clientY - pointer.startY);
    if (held < 250 && dx < 20 && dy < 20) pointer.tapped = true;
    pointer.active = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    hideJoystick();
}

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);

// ─── Dedicated Fire Button (Mobile) ──────────────────────────
const fireButton = document.getElementById('fire-btn');
if (fireButton) {
    fireButton.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        pointer.firePressed = true;
        fireButton.classList.add('fire-active');
        if (navigator.vibrate) navigator.vibrate(20);
        fireButton.setPointerCapture(e.pointerId);
    });
    fireButton.addEventListener('pointerup', (e) => {
        e.preventDefault();
        pointer.firePressed = false;
        fireButton.classList.remove('fire-active');
        try { fireButton.releasePointerCapture(e.pointerId); } catch (_) {}
    });
    fireButton.addEventListener('pointerleave', () => {
        pointer.firePressed = false;
        fireButton.classList.remove('fire-active');
    });
    fireButton.addEventListener('pointercancel', () => {
        pointer.firePressed = false;
        fireButton.classList.remove('fire-active');
    });
}
