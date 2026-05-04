// Quick prod smoke test: connect a WS client to the deployed worker,
// send a hello, wait for welcome + 1 snapshot.
import WebSocket from 'ws';

const URL = process.env.SMOKE_URL ?? 'wss://fzero-server.thomas-grozner.workers.dev/ws?fast=1';

const ws = new WebSocket(URL);
let gotWelcome = false;
let gotSnapshot = false;
let gotPhase = false;
const deadline = Date.now() + 30_000;

const tick = setInterval(() => {
  if (Date.now() > deadline) {
    console.error('TIMEOUT', { gotWelcome, gotPhase, gotSnapshot });
    process.exit(1);
  }
  if (gotWelcome && gotSnapshot && gotPhase) {
    console.log('OK', { gotWelcome, gotPhase, gotSnapshot });
    clearInterval(tick);
    ws.close();
    process.exit(0);
  }
}, 250);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', name: 'smoke', color: '#3aa0ff' }));
});

ws.on('message', (data) => {
  const m = JSON.parse(String(data));
  if (m.type === 'welcome') gotWelcome = true;
  if (m.type === 'snapshot') gotSnapshot = true;
  if (m.type === 'phase' && m.phase === 'COUNTDOWN') gotPhase = true;
});

ws.on('error', (e) => {
  console.error('ws error:', e.message);
  process.exit(1);
});
