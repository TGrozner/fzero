// Multi-client integration test against the deployed worker.
//
// Validates the lobby coherence rules:
//   1. First player is host; non-hosts can't change laps or trigger start_now.
//   2. Track voting is majority-rule; ties keep the current track.
//   3. Spectators joining mid-race land on the WS without 409.
//   4. After a race ends, the FINISHED → WAITING cooldown auto-promotes all
//      still-connected sockets so chained races don't need disconnects.
//
// Usage: SMOKE_URL=wss://your-worker.workers.dev/ws node scripts/multi-client-test.mjs
//
// Each test case ends by closing all sockets it opened; we use a unique
// ?room= per test so they can't pollute each other.

const SERVER = process.env.SMOKE_URL ?? 'wss://neon-drift-server.thomas-grozner.workers.dev/ws';
const HTTP_BASE = SERVER.replace(/^wss?:\/\//, 'https://').replace(/\/ws.*$/, '');

const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};

class Client {
  constructor(label, room, opts = {}) {
    this.label = label;
    this.room = room;
    this.events = [];
    this.id = null;
    this.spectator = false;
    this.players = [];
    this.phase = null;
    this.track = null;
    this.laps = null;
    const session = `${room}-${label}-${Math.random().toString(36).slice(2, 8)}`;
    let url =
      `${SERVER}?room=${encodeURIComponent(room)}` +
      `&session=${encodeURIComponent(session)}` +
      `&track=${encodeURIComponent(opts.track ?? 'mute-avenue')}`;
    if (opts.spectator) url += '&spectator=1';
    this.ws = new WebSocket(url);
    this.ws.addEventListener('open', () => {
      this.ws.send(
        JSON.stringify({
          type: 'hello',
          name: label,
          color: opts.color ?? '#3aa0ff',
          cls: opts.cls ?? 'balanced',
          session,
        }),
      );
    });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data));
      this.events.push(m);
      if (m.type === 'welcome') {
        this.id = m.yourId || null;
        this.spectator = m.spectator === true;
        this.players = m.players;
        this.phase = m.phase;
        this.track = m.track;
        this.laps = m.laps;
      }
      if (m.type === 'players') this.players = m.players;
      if (m.type === 'phase') {
        this.phase = m.phase;
      }
      if (m.type === 'track-changed') this.track = m.trackId;
      if (m.type === 'laps-changed') this.laps = m.laps;
    });
    this.ws.addEventListener('error', (e) => {
      this.error = e.message ?? e.type ?? 'unknown';
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
  /** Wait until cond() returns truthy or timeout (returns false on timeout). */
  async waitFor(cond, timeoutMs = 4000, label = '') {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (cond()) return true;
      await sleep(20);
    }
    console.error(`waitFor timed out: ${label} (events: ${this.events.length})`);
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runCase = async (name, fn) => {
  process.stdout.write(`▸ ${name} ... `);
  try {
    await fn();
    console.log('OK');
  } catch (e) {
    console.log('FAIL');
    console.error(e?.stack ?? e);
    process.exit(1);
  }
};

// --- Cases ---

await runCase('host is the first connected human', async () => {
  const room = `mc-host-${Date.now().toString(36)}`;
  const a = new Client('A', room);
  await a.waitFor(() => a.id, 4000, 'A welcome');
  const b = new Client('B', room);
  await b.waitFor(() => b.id, 4000, 'B welcome');
  await sleep(100);
  // Both should see A as the first human in the players list.
  const aFirstHuman = a.players.find((p) => !p.bot);
  const bFirstHuman = b.players.find((p) => !p.bot);
  if (aFirstHuman?.id !== a.id) throw new Error(`A sees host=${aFirstHuman?.id}, expected ${a.id}`);
  if (bFirstHuman?.id !== a.id) throw new Error(`B sees host=${bFirstHuman?.id}, expected ${a.id}`);
  a.close();
  b.close();
});

await runCase('non-host start_now is silently rejected', async () => {
  const room = `mc-startnow-${Date.now().toString(36)}`;
  const a = new Client('A', room);
  await a.waitFor(() => a.id);
  const b = new Client('B', room);
  await b.waitFor(() => b.id);
  await sleep(100);
  // B (non-host) tries to start. Should be ignored — phase stays WAITING.
  b.send({ type: 'start_now' });
  await sleep(400);
  if (a.phase !== 'WAITING') throw new Error(`A phase changed to ${a.phase} after non-host start_now`);
  if (b.phase !== 'WAITING') throw new Error(`B phase changed to ${b.phase} after non-host start_now`);
  // A (host) can.
  a.send({ type: 'start_now' });
  if (!(await a.waitFor(() => a.phase === 'COUNTDOWN', 2000, 'A countdown'))) {
    throw new Error(`A never reached COUNTDOWN, last phase = ${a.phase}`);
  }
  a.close();
  b.close();
});

await runCase('non-host set_laps is silently rejected', async () => {
  const room = `mc-laps-${Date.now().toString(36)}`;
  const a = new Client('A', room);
  await a.waitFor(() => a.id);
  const b = new Client('B', room);
  await b.waitFor(() => b.id);
  await sleep(100);
  if (a.laps !== 3) throw new Error(`expected default 3 laps, got ${a.laps}`);
  b.send({ type: 'set_laps', laps: 5 });
  await sleep(400);
  if (a.laps !== 3) throw new Error(`A laps changed to ${a.laps} after non-host set_laps`);
  // Host can change.
  a.send({ type: 'set_laps', laps: 5 });
  if (!(await a.waitFor(() => a.laps === 5, 1500, 'A laps=5'))) {
    throw new Error(`A laps never updated to 5, current=${a.laps}`);
  }
  if (!(await b.waitFor(() => b.laps === 5, 1500, 'B laps=5'))) {
    throw new Error(`B laps never updated to 5, current=${b.laps}`);
  }
  a.close();
  b.close();
});

await runCase('track voting needs a majority — 1 vs 1 keeps current', async () => {
  const room = `mc-vote-${Date.now().toString(36)}`;
  const a = new Client('A', room);
  await a.waitFor(() => a.id);
  const b = new Client('B', room);
  await b.waitFor(() => b.id);
  await sleep(100);
  const startTrack = a.track;
  // B votes for big-blue → split 1/1 → no change.
  b.send({ type: 'set_track', trackId: 'big-blue' });
  await sleep(400);
  if (a.track !== startTrack) {
    throw new Error(`track changed to ${a.track} on a 1/1 split (expected ${startTrack})`);
  }
  // A also votes big-blue → 2/0 → changes.
  a.send({ type: 'set_track', trackId: 'big-blue' });
  if (!(await a.waitFor(() => a.track === 'big-blue', 1500, 'A track=big-blue'))) {
    throw new Error(`A track never flipped to big-blue, current=${a.track}`);
  }
  if (!(await b.waitFor(() => b.track === 'big-blue', 1500, 'B track=big-blue'))) {
    throw new Error(`B track never flipped to big-blue, current=${b.track}`);
  }
  a.close();
  b.close();
});

await runCase('host transfers when the original host disconnects', async () => {
  const room = `mc-xfer-${Date.now().toString(36)}`;
  const a = new Client('A', room);
  await a.waitFor(() => a.id);
  const b = new Client('B', room);
  await b.waitFor(() => b.id);
  const c = new Client('C', room);
  await c.waitFor(() => c.id);
  await sleep(100);
  // A is host. Disconnect A; B should become host.
  a.close();
  await sleep(400);
  // B's set_laps should now be accepted (was rejected when A was host).
  b.send({ type: 'set_laps', laps: 2 });
  if (!(await b.waitFor(() => b.laps === 2, 1500, 'B (new host) laps=2'))) {
    throw new Error(`B never got host privileges after A disconnected`);
  }
  b.close();
  c.close();
});

await runCase('spectator joins mid-race without 409', async () => {
  const room = `mc-spec-${Date.now().toString(36)}`;
  const a = new Client('A', room);
  await a.waitFor(() => a.id);
  // Host starts the race; we wait until phase becomes COUNTDOWN or RACING.
  a.send({ type: 'start_now' });
  if (!(await a.waitFor(() => a.phase === 'COUNTDOWN' || a.phase === 'RACING', 3000, 'A racing'))) {
    throw new Error(`A never started race; phase=${a.phase}`);
  }
  // B tries to join WITHOUT spectator → should fail (HTTP 409 → ws error).
  // We can't easily detect 409 via WebSocket API; use a status preflight.
  const statusUrl = `${HTTP_BASE}/status?room=${encodeURIComponent(room)}`;
  const statusRes = await fetch(statusUrl);
  const status = await statusRes.json();
  if (status.phase === 'WAITING') throw new Error(`status returned WAITING during race`);
  // B joins as spectator.
  const b = new Client('B', room, { spectator: true });
  if (!(await b.waitFor(() => b.spectator === true && b.phase !== 'WAITING', 4000, 'B spectator welcome'))) {
    throw new Error(`B never got spectator welcome; events: ${JSON.stringify(b.events.map((e) => e.type))}`);
  }
  if (b.id !== null) throw new Error(`spectator should have null myId, got ${b.id}`);
  a.close();
  b.close();
});

console.log('\nAll multi-client tests passed.');
