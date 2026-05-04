import { RoomCore } from '../shared/roomCore.ts';
import {
  decodeClient,
  decodeInput,
  encode,
  type ServerMessage,
} from '../shared/protocol.ts';
import {
  SERVER_TICK_MS,
  WS_CLOSE_PROTOCOL_ERROR,
  WS_CLOSE_ROOM_FULL,
} from '../shared/constants.ts';

export interface Env {
  ROOM: DurableObjectNamespace;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
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
    if (url.pathname === '/ws') {
      const roomName = url.searchParams.get('room') ?? 'lobby';
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
      return new Response('fzero server', { status: 200, headers: CORS_HEADERS });
    }
    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  },
};

type ConnAttachment = { connId: string };

export class Room {
  private state: DurableObjectState;
  private core: RoomCore;
  private connSeq = 0;
  private lastTickMs = 0;

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
    if (url.pathname !== '/ws') return new Response('not found', { status: 404 });
    const upgrade = request.headers.get('Upgrade');
    if (upgrade?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    // Apply query overrides (only takes effect while WAITING).
    if (this.core.phase === 'WAITING') {
      const fast = url.searchParams.get('fast') === '1';
      if (fast) this.core.lobbyAutoStartS = 2;
      const track = url.searchParams.get('track');
      if (track) {
        try {
          this.core = new RoomCore(track, 50, this.core.lobbyAutoStartS);
        } catch {
          // unknown track id — ignore and keep default
        }
      }
    }
    if (this.core.players.size >= 99 || this.core.phase !== 'WAITING') {
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
    const att = ws.deserializeAttachment() as ConnAttachment | null;
    if (!att) return;
    const msg = decodeClient(raw);
    if (!msg) {
      this.closeWith(ws, WS_CLOSE_PROTOCOL_ERROR, 'bad message');
      return;
    }
    if (msg.type === 'hello') {
      try {
        const { id, welcome } = this.core.addHuman(att.connId, msg.name, msg.color);
        // Replace attachment connId with playerId for fast input lookup.
        ws.serializeAttachment({ connId: att.connId } satisfies ConnAttachment);
        ws.send(encode(welcome));
        this.broadcastExcept(ws, { type: 'players', players: this.core.playerInfos() });
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
    const dt = this.lastTickMs === 0 ? 1 / 30 : Math.min(0.1, (now - this.lastTickMs) / 1000);
    this.lastTickMs = now;
    const out = this.core.step(dt);
    if (out.snapshot) this.broadcast(out.snapshot);
    for (const ev of out.events) this.broadcast(ev);
    // Always reschedule unless room is empty.
    const sockets = this.state.getWebSockets();
    if (sockets.length > 0 || this.core.phase !== 'WAITING') {
      await this.state.storage.setAlarm(now + SERVER_TICK_MS);
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
