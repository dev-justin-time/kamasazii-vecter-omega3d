// ─── Configuration ────────────────────────────────────────────────
export const CONFIG = {
    wsUrl: `ws://${location.hostname}:8080/ws`,
    useWasm: true,
    playerName: `pilot_${Math.random().toString(36).slice(2, 8)}`,
    hotReload: {
        enabled: true,
        intervalMs: 1500,
        scripts: [
            { name: 'weapons.rhai', path: './scripts/weapons.rhai' },
            { name: 'ai_apex.rhai', path: './scripts/ai_apex.rhai' },
        ],
    },
    analytics: {
        enabled: false,
        endpoint: null,
    },
};
