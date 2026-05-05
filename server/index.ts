import { RoomCore } from '../shared/roomCore.ts';
import {
  decodeClient,
  decodeInput,
  encode,
  type ServerMessage,
} from '../shared/protocol.ts';
import {
  MAX_ROOM_NAME_LEN,
  ROOM_NAME_PATTERN,
  SERVER_TICK_MS,
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
      const trackId = url.searchParams.get('track') ?? 'mute-avenue';
      const fast = url.searchParams.get('fast') === '1';
      const id = env.ROOM.idFromName(roomName);
      const stub = env.ROOM.get(id);
      const fwd = new Request(
        `https://room/ws?track=${encodeURIComponent(trackId)}${fast ? '&fast=1' : ''}`,
        request,
      );
      return stub.fetch(fwd);
    }
    if (url.pathname === '/') {
      return new Response('neon-drift server', { status: 200, headers: CORS_HEADERS });
    }
    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  },
};

type ConnAttachment = { connId: string };

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
    // If the previous race is over, reset back to a fresh lobby + close any lingering sockets.
    if (this.core.phase === 'FINISHED') {
      for (const ws of this.state.getWebSockets()) {
        try { ws.close(1000, 'race over'); } catch { /* ignore */ }
      }
      this.core.resetToWaiting();
    }
    // Apply query overrides (only takes effect while WAITING).
    if (this.core.phase === 'WAITING') {
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
    // Allow upgrades during RACING/COUNTDOWN if the client has a known
    // session token: they may be reconnecting to claim back their bot.
    const session = url.searchParams.get('session');
    const isReconnect =
      session !== null &&
      this.core.phase !== 'WAITING' &&
      this.core.phase !== 'FINISHED' &&
      [...this.core.players.values()].some((p) => p.session === session && p.bot);
    if (
      !isReconnect &&
      (this.core.players.size >= 99 || this.core.phase !== 'WAITING')
    ) {
      return new Response('room full or already started', {
        status: 409,
        headers: CORS_HEADERS,
      });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    const connId = `c${++this.connSeq}`;
    server.serializeAttachment({ connId } satisfies ConnAttachment);
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
      try {
        const { id, welcome } = this.core.addHuman(
          att.connId,
          msg.name,
          msg.color,
          msg.session ?? null,
          msg.cls,
        );
        // Replace attachment connId with playerId for fast input lookup.
        ws.serializeAttachment({ connId: att.connId } satisfies ConnAttachment);
        ws.send(encode(welcome));
        this.broadcastExcept(ws, { type: 'players', players: this.core.playerInfos() });
        // Re-send a snapshot so the reconnecting client can render immediately.
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
      // Any human in the room can start the race when they're good to go.
      if (this.core.phase !== 'WAITING') return;
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
      const changed = this.core.setTrack(msg.trackId);
      if (changed) {
        this.broadcast({ type: 'track-changed', trackId: msg.trackId });
        this.broadcast({ type: 'players', players: this.core.playerInfos() });
      }
      return;
    }
    if (msg.type === 'set_laps') {
      if (typeof msg.laps !== 'number') return;
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
    const out = this.core.step(dt);
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
