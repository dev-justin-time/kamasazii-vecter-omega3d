// ─── Configuration ────────────────────────────────────────────────
// WebSocket URL resolution order:
//   1. URL override via ?ws= param (for testing custom servers)
//   2. window.__KAMIKAZZI_WS_URL (set by deployment script)
//   3. Production default: wss://kamikazzi-server.fly.dev/ws
//   4. Fallback: localhost:8080 for development
const _detectedWsUrl = (() => {
  const params = new URLSearchParams(location.search);
  if (params.get('ws')) return params.get('ws');
  if (window.__KAMIKAZZI_WS_URL) return window.__KAMIKAZZI_WS_URL;
  if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    return `wss://kamikazzi-server.fly.dev/ws`;
  }
  return `ws://${location.hostname}:8080/ws`;
})();

export const CONFIG = {
    wsUrl: _detectedWsUrl,
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
