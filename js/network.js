// ─── Network: WebSocket + Puter.js ───────────────────────────
// All server communication and cloud integration in one place.

import { CONFIG } from './config.js';
import { elements } from './dom.js';
import { state } from './state.js';
import { updateHUD } from './hud.js';

// ═══ WebSocket Multiplayer Client ══════════════════════════════

export function connectWebSocket() {
    const url = CONFIG.wsUrl + '?room=omega_arena&player_id=' + CONFIG.playerName;
    elements.wsDot.className = 'status-dot connecting';
    elements.wsStatus.textContent = 'CONNECTING...';

    try {
        state.ws = new WebSocket(url);

        state.ws.onopen = () => {
            elements.wsDot.className = 'status-dot connected';
            elements.wsStatus.textContent = 'CONNECTED';
        };

        state.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                switch (msg.type) {
                    case 'welcome':
                        console.log('[WS]', msg.message, 'as', msg.yourID);
                        break;
                    case 'state':
                        updateMultiplayerState(msg);
                        break;
                    case 'event':
                        console.log('[WS EVENT]', msg.message);
                        break;
                }
            } catch (e) {
                console.warn('[WS] Parse error:', e);
            }
        };

        state.ws.onclose = () => {
            elements.wsDot.className = 'status-dot disconnected';
            elements.wsStatus.textContent = 'DISCONNECTED';
            setTimeout(connectWebSocket, 3000);
        };

        state.ws.onerror = () => {
            elements.wsDot.className = 'status-dot disconnected';
            elements.wsStatus.textContent = 'ERROR';
        };
    } catch (e) {
        console.warn('[WS] Connection error:', e);
        setTimeout(connectWebSocket, 3000);
    }
}

function updateMultiplayerState(msg) {
    if (msg.players) {
        const me = msg.players.find(p => p.id === CONFIG.playerName);
        if (me) {
            state.health = me.health;
            state.energy = me.energy;
            state.score = me.score;
            updateHUD();
        }
    }
}

export function sendInput(pitch, yaw, roll, throttle) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'input', pitch, yaw, roll, throttle }));
    }
}

export function sendFire(weapon) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'fire', fire: weapon }));
    }
}

export function sendGlitch() {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'glitch' }));
    }
}

// ═══ Puter.js Integration ══════════════════════════════════════

export async function initPuter() {
    try {
        if (typeof puter === 'undefined') {
            elements.puterStatus.textContent = 'PUTER: SDK MISSING';
            return;
        }
        elements.puterDot.className = 'status-dot connecting';
        elements.puterStatus.textContent = 'PUTER: CONNECTING...';

        if (puter.auth && puter.auth.isSignedIn && !puter.auth.isSignedIn()) {
            elements.puterStatus.textContent = 'PUTER: SIGN IN REQUIRED';
            return;
        }

        state.puterReady = true;
        elements.puterDot.className = 'status-dot connected';
        elements.puterStatus.textContent = 'PUTER: ONLINE';
        console.log('[PUTER] SDK initialized successfully');
    } catch (e) {
        console.warn('[PUTER] Init error:', e);
        elements.puterDot.className = 'status-dot disconnected';
        elements.puterStatus.textContent = 'PUTER: OFFLINE';
    }
}

// ─── Puter AI: Generate Mission Briefing ─────────────────────

export async function generateMissionBriefing() {
    try {
        if (!state.puterReady || typeof puter === 'undefined' || !puter.ai) {
            elements.briefingText.textContent =
                'Sector Omega — Corrupted data-tower detected. Eliminate all hostile signals. ' +
                'Vector cannons online. Glitch drive standing by. Good hunting, pilot.';
            return;
        }
        elements.briefingText.textContent = 'Accessing neural grid for mission parameters...';
        const response = await puter.ai.chat(
            "Generate a 2-sentence cyberpunk mission briefing for a wireframe dogfighter. " +
            "The player must destroy a corrupted data-tower defended by neural AI fighters. " +
            "Use dramatic, gritty tone. Mention the environment (neon grid, data-scattered sky)."
        );
        elements.briefingText.textContent = response || 'Mission parameters corrupted — proceed with default directive.';
        elements.missionText.textContent = response || 'Sector Omega — eliminate all hostiles.';
    } catch (e) {
        console.warn('[AI] Briefing generation failed:', e);
        elements.briefingText.textContent =
            'Sector Omega — default directives loaded. Eliminate all hostiles. Good luck, pilot.';
    }
}

// ─── Puter KV: Save/Load Loadout ─────────────────────────────

export async function saveLoadout(loadout) {
    const si = document.getElementById("sync-icon");
    const st = document.getElementById("sync-text");
    if (window.__syncErrorTimer) clearTimeout(window.__syncErrorTimer);
    function setSync(icon, msg) {
        if (si) si.textContent = icon;
        if (st) st.textContent = msg;
    }
    try {
        if (!state.puterReady || typeof puter === "undefined") {
            setSync("\u26e4", "Offline");
            return;
        }
        setSync("\u23f3", "Saving...");
        await puter.kv.set("omni_loadout_v1", JSON.stringify(loadout));
        setSync("\u2601\ufe0f", "Saved");
        console.log("[PUTER KV] Loadout saved");
    } catch (e) {
        setSync("\u26a0\ufe0f", "Error");
        console.warn("[PUTER KV] Save error:", e);
        setTimeout(function() {
            if (st && st.textContent === "Error") setSync("\u2601\ufe0f", "Ready");
        }, 3000);
    }
}

export async function loadLoadout() {
    try {
        if (!state.puterReady || typeof puter === 'undefined') return null;
        const data = await puter.kv.get('omni_loadout_v1');
        return data ? JSON.parse(data) : null;
    } catch (e) {
        console.warn('[PUTER KV] Load error:', e);
        return null;
    }
}

// ─── Puter FS: Save Replay ───────────────────────────────────

export async function saveReplay(replayData) {
    try {
        if (!state.puterReady || typeof puter === 'undefined') {
            alert('Puter.js required for cloud saves. Sign in to save replays.');
            return;
        }
        const blob = new Blob([replayData], { type: 'application/octet-stream' });
        await puter.fs.write('/VectorStrike_Replays/match_' + Date.now() + '.bin', blob);
        console.log('[PUTER FS] Replay saved to cloud drive');
    } catch (e) {
        console.warn('[PUTER FS] Save error:', e);
    }
}

// Expose saveReplay globally (used by star_sparrow_builder.js)
window.saveReplay = saveReplay;
