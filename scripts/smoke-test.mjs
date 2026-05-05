// Cheap prod smoke test for CI: verifies the worker responds and a WS handshake
// + hello/welcome roundtrip works.
//
// IMPORTANT: this test is intentionally low-cost. It uses a dedicated `smoke`
// room, never sends `fast=1`, and closes the socket right after `welcome` —
// the DO drops back to idle WAITING with no scheduled alarm, costing ~5 DO
// requests per run instead of ~1900 for a full race.
//
// Usage:
//   SMOKE_URL=wss://your-worker.workers.dev/ws node scripts/smoke-test.mjs
//
// Strip the path/query — we'll add /health + /ws ourselves.
// Uses Node 22+ native WebSocket (no `ws` dependency).

const RAW = process.env.SMOKE_URL;
if (!RAW) {
  console.error('SMOKE_URL env var is required (e.g. wss://your-worker.workers.dev/ws)');
  process.exit(2);
}
const u = new URL(RAW);
const httpScheme = u.protocol === 'wss:' ? 'https:' : 'http:';
const healthUrl = `${httpScheme}//${u.host}/health`;
const wsUrl = `${u.protocol}//${u.host}/ws?room=smoke&track=mute-avenue`;

const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};

const healthRes = await fetch(healthUrl);
if (!healthRes.ok) fail(`/health returned ${healthRes.status}`);
const body = (await healthRes.text()).trim();
if (body !== 'ok') fail(`/health body: ${body}`);

await new Promise((resolve) => {
  const ws = new WebSocket(wsUrl);
  let gotWelcome = false;
  const timer = setTimeout(() => {
    try { ws.close(); } catch { /* ignore */ }
    fail('timeout waiting for welcome (10s)');
  }, 10_000);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'hello', name: 'smoke', color: '#3aa0ff' }));
  });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === 'welcome') {
      gotWelcome = true;
      clearTimeout(timer);
      ws.close(1000, 'smoke ok');
    }
  });
  ws.addEventListener('close', () => {
    if (!gotWelcome) fail('socket closed before welcome');
    console.log('OK { gotHealth: true, gotWelcome: true }');
    resolve();
  });
  ws.addEventListener('error', (e) => {
    // Some platforms fire a synthetic 'error' alongside graceful close after we
    // call ws.close(); only treat it as a failure if welcome never arrived.
    if (gotWelcome) return;
    fail(`ws error: ${e.message ?? e.error ?? e.type ?? 'unknown'}`);
  });
});
