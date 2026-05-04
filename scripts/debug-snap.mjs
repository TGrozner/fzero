import WebSocket from 'ws';

const URL = process.env.SMOKE_URL ?? `ws://127.0.0.1:8787/ws?fast=1&room=debug-${Date.now()}`;
const ws = new WebSocket(URL);
let snaps = 0;
ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', name: 'dbg', color: '#3aa0ff' })));
ws.on('message', (d) => {
  const m = JSON.parse(String(d));
  if (m.type === 'snapshot') {
    snaps++;
    if (snaps % 20 === 1)
      console.log(`tick=${m.tick} ships=${m.ships.length} racersLeft=${m.racersLeft}`);
    if (snaps >= 80) {
      ws.close();
      process.exit(0);
    }
  } else if (m.type !== 'pong') {
    console.log('MSG:', m.type, JSON.stringify(m).slice(0, 200));
  }
});
ws.on('error', (e) => console.error('ERR', e.message));
setTimeout(() => process.exit(2), 30000);
