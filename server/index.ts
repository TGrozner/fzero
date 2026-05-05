import { RoomCore } from '../shared/roomCore.ts';
import {
  decodeClient,
  decodeInput,
  encode,
  type ServerMessage,
} from '../shared/protocol.ts';
import {
  DEFAULT_SHIP_CLASS,
  MAX_ROOM_NAME_LEN,
  ROOM_NAME_PATTERN,
  SERVER_TICK_MS,
  type ShipClass,
  WS_CLOSE_PROTOCOL_ERROR,
  WS_CLOSE_RATE_LIMITED,
  WS_CLOSE_ROOM_FULL,
  WS_INPUT_RATE_LIMIT_PER_S,
  WS_MAX_MESSAGE_BYTES,
} from '../shared/constants.ts';

export interface Env {
  ROOM: DurableObjectNamespace;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

/**
 * Reject pathological room names early so a hostile client can't spawn a
 * thousand Durable Objects by varying `?room=` — which would burn through
 * the Cloudflare free tier and never expire (DOs persist after first request).
 */
const sanitizeRoomName = (raw: string | null): string => {
  const candidate = (raw ?? 'lobby').slice(0, MAX_ROOM_NAME_LEN);
  return ROOM_NAME_PATTERN.test(candidate) ? candidate : 'lobby';
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (url.pathname === '/health') {
      return new Response('ok', { status: 200, headers: CORS_HEADERS });
    }
    if (url.pathname === '/status') {
      // Lightweight pre-flight so the client can show "Race in progress —
      // wait or pick another room" before attempting a WS upgrade. One DO
      // request per check; clients should not poll faster than every few s.
      const roomName = sanitizeRoomName(url.searchParams.get('room'));
      const id = env.ROOM.idFromName(roomName);
      const stub = env.ROOM.get(id);
      const fwd = new Request(`https://room/status`, request);
      return stub.fetch(fwd);
    }
    if (url.pathname === '/ws') {
      const roomName = sanitizeRoomName(url.searchParams.get('room'));
      const id = env.ROOM.idFromName(roomName);
      const stub = env.ROOM.get(id);
      // Forward every query param except `room` (the DO is identified by
      // the binding now) so session reconnects, spectator flags, fast-mode,
      // and track overrides all reach the Room.
      const inner = new URL('https://room/ws');
      for (const [k, v] of url.searchParams) {
        if (k !== 'room') inner.searchParams.set(k, v);
      }
      const fwd = new Request(inner.toString(), request);
      return stub.fetch(fwd);
    }
    if (url.pathname === '/') {
      return new Response('neon-drift server', { status: 200, headers: CORS_HEADERS });
    }
    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  },
};

/**
 * Per-WebSocket persisted state.
 *
 * `helloInfo` is captured on the first hello so that when the room cycles
 * from FINISHED → WAITING (auto-cooldown) we can promote every still-open
 * connection — both regular players AND spectators who joined mid-race —
 * back into core.players without a disconnect/reconnect dance.
 *
 * `spectator` is true only while the connection is observing without a
 * vehicle. It flips to false the moment the server promotes them to a
 * player (start of next WAITING phase).
 */
type ConnAttachment = {
  connId: string;
  helloInfo?: {
    name: string;
    color: string;
    cls: ShipClass;
    session: string | null;
  };
  spectator?: boolean;
};

/**
 * Token-bucket rate limit per WebSocket. We refill `WS_INPUT_RATE_LIMIT_PER_S`
 * tokens/second up to a small burst budget. Anything beyond closes the socket
 * with WS_CLOSE_RATE_LIMITED — protects DO request count under abuse.
 */
type RateState = { tokens: number; lastRefillMs: number };
const BURST = WS_INPUT_RATE_LIMIT_PER_S; // 1s of headroom

export class Room {
  private state: DurableObjectState;
  private core: RoomCore;
  private connSeq = 0;
  private lastTickMs = 0;
  private rates = new WeakMap<WebSocket, RateState>();

  private allow(ws: WebSocket): boolean {
    const now = Date.now();
    let r = this.rates.get(ws);
    if (!r) {
      r = { tokens: BURST, lastRefillMs: now };
      this.rates.set(ws, r);
    }
    const elapsed = (now - r.lastRefillMs) / 1000;
    r.tokens = Math.min(BURST, r.tokens + elapsed * WS_INPUT_RATE_LIMIT_PER_S);
    r.lastRefillMs = now;
    if (r.tokens < 1) return false;
    r.tokens -= 1;
    return true;
  }

  constructor(state: DurableObjectState) {
    this.state = state;
    const trackId = 'mute-avenue';
    this.core = new RoomCore(trackId);
    // Re-seed connId mapping by reading attachments.
    const sockets = this.state.getWebSockets();
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as ConnAttachment | null;
      if (att?.connId) {
        // No-op: the player is already in core.players if we've reloaded state from storage.
        // For v1 we keep state in memory; on restart, all sessions get bumped (clients reconnect).
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/status') {
      const humans = [...this.core.players.values()].filter((p) => !p.bot).length;
      return new Response(
        JSON.stringify({
          phase: this.core.phase,
          humans,
          maxPlayers: 99,
          trackId: this.core.track.id,
          laps: this.core.totalLaps,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
      );
    }
    if (url.pathname !== '/ws') return new Response('not found', { status: 404 });
    const upgrade = request.headers.get('Upgrade');
    if (upgrade?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    // If the room is sitting in FINISHED with nobody still connected, snap
    // it straight back to WAITING so a fresh visitor (or e2e test re-using
    // the default lobby) doesn't hit a 409 for the entire 8 s cooldown.
    // The auto-rejoin path in alarm() handles the FINISHED → WAITING
    // transition WHEN sockets are still open; this only applies when they
    // aren't.
    if (this.core.phase === 'FINISHED' && this.state.getWebSockets().length === 0) {
      this.core.resetToWaiting();
    }
    // Apply query overrides (only takes effect while WAITING). Track override
    // only fires before any human is in the room, so we don't blow away an
    // active vote tally just because someone joined with a different ?track=.
    if (this.core.phase === 'WAITING' && this.core.players.size === 0) {
      const fast = url.searchParams.get('fast') === '1';
      const track = url.searchParams.get('track');
      if (track) {
        try {
          this.core = new RoomCore(track);
        } catch {
          // unknown track id — ignore and keep default
        }
      }
      // `?fast=1` is for e2e/CI: arms a 2 s auto-start so tests don't have to
      // click the Start now button. Production never sets this.
      if (fast) this.core.startsIn = 2;
    }
    // Connection rules:
    // - ?spectator=1 → always allowed (joins as observer, promoted on next WAITING)
    // - ?session=X reconnect to a bot-piloted vehicle → allowed mid-race
    // - otherwise → only during WAITING and only if the room isn't full
    const session = url.searchParams.get('session');
    const wantsSpectator = url.searchParams.get('spectator') === '1';
    const isReconnect =
      session !== null &&
      this.core.phase !== 'WAITING' &&
      [...this.core.players.values()].some((p) => p.session === session && p.bot);
    if (this.core.players.size >= 99 && !wantsSpectator && !isReconnect) {
      return new Response('room full', { status: 409, headers: CORS_HEADERS });
    }
    if (!isReconnect && !wantsSpectator && this.core.phase !== 'WAITING') {
      // The client should retry with ?spectator=1 to watch and auto-join the
      // next race; surfacing 409 keeps the contract explicit.
      return new Response('race already started', { status: 409, headers: CORS_HEADERS });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    const connId = `c${++this.connSeq}`;
    // Spectator flag is only set when we couldn't have joined as a player
    // (i.e. we're not in WAITING). In WAITING, even a `?spectator=1` request
    // becomes a regular player — there's no race to spectate yet.
    const becomesSpectator = wantsSpectator && this.core.phase !== 'WAITING';
    server.serializeAttachment({
      connId,
      ...(becomesSpectator ? { spectator: true } : {}),
    } satisfies ConnAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== 'string') return;
    if (raw.length > WS_MAX_MESSAGE_BYTES) {
      this.closeWith(ws, WS_CLOSE_PROTOCOL_ERROR, 'message too large');
      return;
    }
    if (!this.allow(ws)) {
      this.closeWith(ws, WS_CLOSE_RATE_LIMITED, 'rate limited');
      return;
    }
    const att = ws.deserializeAttachment() as ConnAttachment | null;
    if (!att) return;
    const msg = decodeClient(raw);
    if (!msg) {
      this.closeWith(ws, WS_CLOSE_PROTOCOL_ERROR, 'bad message');
      return;
    }
    if (msg.type === 'hello') {
      const cls: ShipClass = msg.cls ?? DEFAULT_SHIP_CLASS;
      // Persist the hello on the attachment so the FINISHED → WAITING
      // auto-promotion knows how to re-add this socket as a player on the
      // next race without a disconnect/reconnect cycle.
      const helloInfo = {
        name: msg.name,
        color: msg.color,
        cls,
        session: msg.session ?? null,
      };
      ws.serializeAttachment({ ...att, helloInfo } satisfies ConnAttachment);

      if (att.spectator) {
        // Don't addHuman — they're observing this race. Send a spectator
        // welcome with the current state so they can render immediately.
        ws.send(
          encode({
            type: 'welcome',
            yourId: '',
            track: this.core.track.id,
            laps: this.core.totalLaps,
            players: this.core.playerInfos(),
            phase: this.core.phase,
            countdown: this.core.countdown,
            startsIn: this.core.startsIn,
            spectator: true,
          }),
        );
        if (this.core.phase === 'RACING' || this.core.phase === 'COUNTDOWN') {
          ws.send(
            encode({
              type: 'snapshot',
              tick: this.core.tick,
              time: this.core.raceTime,
              ships: this.core.snapshotShips(),
              racersLeft: [...this.core.vehicles.values()].filter((v) => !v.ko && !v.finished).length,
              pk: this.core.pickupActiveMask(),
            }),
          );
        }
        this.ensureAlarmScheduled();
        return;
      }

      try {
        const { id, welcome } = this.core.addHuman(
          att.connId,
          helloInfo.name,
          helloInfo.color,
          helloInfo.session,
          helloInfo.cls,
        );
        ws.send(encode(welcome));
        this.broadcastExcept(ws, { type: 'players', players: this.core.playerInfos() });
        if (this.core.phase === 'RACING' || this.core.phase === 'COUNTDOWN') {
          ws.send(
            encode({
              type: 'snapshot',
              tick: this.core.tick,
              time: this.core.raceTime,
              ships: this.core.snapshotShips(),
              racersLeft: [...this.core.vehicles.values()].filter((v) => !v.ko && !v.finished).length,
              pk: this.core.pickupActiveMask(),
            }),
          );
        }
        this.ensureAlarmScheduled();
        void id;
      } catch (e) {
        this.closeWith(ws, WS_CLOSE_ROOM_FULL, String(e));
      }
      return;
    }
    if (msg.type === 'input') {
      this.core.applyInput(att.connId, decodeInput(msg.in));
      return;
    }
    if (msg.type === 'ping') {
      ws.send(encode({ type: 'pong', ts: msg.ts }));
      return;
    }
    if (msg.type === 'start_now') {
      // Host-only: in a multi-player lobby, only the longest-connected human
      // can override the Ready flow. Any other client clicking the button
      // (which they shouldn't — the UI hides it for non-hosts — but a
      // hand-crafted message could) is silently ignored.
      if (this.core.phase !== 'WAITING') return;
      if (!this.core.isHost(att.connId)) return;
      this.core.startsIn = 0;
      this.broadcast({ type: 'phase', phase: 'WAITING', startsIn: 0 });
      void this.state.storage.setAlarm(Date.now() + 50);
      return;
    }
    if (msg.type === 'set_ready') {
      const { allReady, humans } = this.core.setReady(att.connId, msg.ready === true);
      this.broadcast({ type: 'players', players: this.core.playerInfos() });
      if (allReady && humans >= 1) {
        this.core.startsIn = 0;
        this.broadcast({ type: 'phase', phase: 'WAITING', startsIn: 0 });
        void this.state.storage.setAlarm(Date.now() + 50);
      }
      return;
    }
    if (msg.type === 'set_track') {
      if (typeof msg.trackId !== 'string') return;
      const { voteRecorded, trackChanged } = this.core.setTrackVote(att.connId, msg.trackId);
      if (voteRecorded) {
        this.broadcast({ type: 'players', players: this.core.playerInfos() });
        if (trackChanged) {
          this.broadcast({ type: 'track-changed', trackId: this.core.track.id });
        }
      }
      return;
    }
    if (msg.type === 'set_laps') {
      // Host-only — same rationale as start_now. Lap count is a global
      // race setting, so only one player should drive it.
      if (typeof msg.laps !== 'number') return;
      if (!this.core.isHost(att.connId)) return;
      const changed = this.core.setLaps(msg.laps);
      if (changed) {
        this.broadcast({ type: 'laps-changed', laps: this.core.totalLaps });
        this.broadcast({ type: 'players', players: this.core.playerInfos() });
      }
      return;
    }
    if (msg.type === 'set_class') {
      if (typeof msg.cls !== 'string') return;
      const changed = this.core.setClass(att.connId, msg.cls);
      if (changed) {
        this.broadcast({ type: 'players', players: this.core.playerInfos() });
      }
      return;
    }
    if (msg.type === 'set_rtt') {
      if (typeof msg.rtt !== 'number') return;
      const changed = this.core.setRtt(att.connId, msg.rtt);
      if (changed) {
        this.broadcast({ type: 'players', players: this.core.playerInfos() });
      }
      return;
    }
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    const att = ws.deserializeAttachment() as ConnAttachment | null;
    if (att?.connId) this.core.removeHuman(att.connId);
    this.broadcast({ type: 'players', players: this.core.playerInfos() });
  }

  webSocketError(ws: WebSocket, _err: unknown): void {
    const att = ws.deserializeAttachment() as ConnAttachment | null;
    if (att?.connId) this.core.removeHuman(att.connId);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    // While WAITING we only need to bleed `startsIn`; tick once a second instead
    // of 10× to keep DO request counts low on the free tier. step() is safe with
    // larger dt during WAITING — it just decrements `startsIn` linearly.
    const waitingDt = this.lastTickMs === 0 ? 1 : Math.min(2, (now - this.lastTickMs) / 1000);
    // dt cap = 2× nominal tick so a missed alarm doesn't tunnel physics, but
    // keep enough headroom for the 5 Hz nominal cadence (200 ms).
    const racingDt = this.lastTickMs === 0 ? 1 / 30 : Math.min(0.4, (now - this.lastTickMs) / 1000);
    const dt = this.core.phase === 'WAITING' ? waitingDt : racingDt;
    this.lastTickMs = now;
    const phaseBefore = this.core.phase;
    const out = this.core.step(dt);
    // FINISHED → WAITING transition: promote every still-connected socket
    // (including spectators that joined mid-race) so the same friend group
    // can chain races without anyone disconnect-reconnect-ing.
    if (phaseBefore === 'FINISHED' && this.core.phase === 'WAITING') {
      this.promoteAllConnected();
    }
    if (out.snapshot) this.broadcast(out.snapshot);
    for (const ev of out.events) this.broadcast(ev);
    // Reschedule unless the room is fully idle (no sockets AND back in WAITING).
    const sockets = this.state.getWebSockets();
    const empty = sockets.length === 0 && this.core.phase === 'WAITING';
    if (!empty) {
      const nextMs = this.core.phase === 'WAITING' ? 1000 : SERVER_TICK_MS;
      await this.state.storage.setAlarm(now + nextMs);
    }
  }

  /**
   * Promote all open sockets into players. Called at the start of every fresh
   * lobby (after the FINISHED cooldown) so connected results-screen viewers
   * AND spectators auto-rejoin without a disconnect/reconnect dance. Each
   * socket gets a personalized welcome with their freshly-allocated player id.
   */
  private promoteAllConnected(): void {
    let anyAdded = false;
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() as ConnAttachment | null;
      if (!att?.helloInfo) continue;
      const already = [...this.core.players.values()].some((p) => p.connId === att.connId);
      if (already) continue;
      try {
        const { welcome } = this.core.addHuman(
          att.connId,
          att.helloInfo.name,
          att.helloInfo.color,
          att.helloInfo.session,
          att.helloInfo.cls,
        );
        ws.serializeAttachment({ ...att, spectator: false } satisfies ConnAttachment);
        ws.send(encode(welcome));
        anyAdded = true;
      } catch {
        // Room full or otherwise rejected — skip; the socket stays alive
        // and will retry on the next FINISHED → WAITING transition.
      }
    }
    if (anyAdded) {
      this.broadcast({ type: 'players', players: this.core.playerInfos() });
    }
  }

  private ensureAlarmScheduled(): void {
    void this.state.storage
      .getAlarm()
      .then((existing) => {
        if (existing === null) {
          void this.state.storage.setAlarm(Date.now() + SERVER_TICK_MS);
        }
      })
      .catch(() => {
        void this.state.storage.setAlarm(Date.now() + SERVER_TICK_MS);
      });
  }

  private broadcast(msg: ServerMessage): void {
    const text = encode(msg);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // ignore failed sends; close handler will clean up
      }
    }
  }

  private broadcastExcept(except: WebSocket, msg: ServerMessage): void {
    const text = encode(msg);
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(text);
      } catch {
        // ignore
      }
    }
  }

  private closeWith(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // ignore
    }
  }
}
