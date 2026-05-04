import type { RoomPhase, ShipClass } from '../shared/constants.ts';
import type { PlayerInfoMsg, ServerMessage, ShipSnapshot } from '../shared/protocol.ts';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

export type Snapshot = {
  readonly tick: number;
  readonly time: number;
  readonly receivedAt: number;
  readonly ships: readonly ShipSnapshot[];
  readonly racersLeft: number;
  /** Bitmask of active pickups. */
  readonly pk: number;
};

export type PickupEvent = {
  readonly idx: number;
  readonly kind: 'boost' | 'heal' | 'mine';
  readonly vehicleId: string;
  readonly at: number;
};

export type KoLogEntry = {
  readonly id: string;
  readonly by: string | null;
  readonly time: number;
  /** Snapshot position at the time the KO was received, or null if unknown. */
  readonly x: number | null;
  readonly y: number | null;
};

export type HitEvent = {
  readonly victim: string;
  readonly attacker: string | null;
  readonly kind: 'spin' | 'side-left' | 'side-right' | 'wall' | 'collision';
  readonly x: number;
  readonly y: number;
  /** receivedAt (ms) — used as a unique key for renderer dedup. */
  readonly at: number;
};

export type Standing = {
  id: string;
  position: number;
  finishTime: number | null;
  ko: boolean;
};

export type ClientState = {
  /** Top-level UI screen. */
  view: 'menu' | 'lobby' | 'race' | 'results';
  status: ConnectionStatus;
  pseudo: string;
  color: string;
  /** Server-assigned id for this client. */
  myId: string | null;
  trackId: string;
  /** Selected ship class. */
  cls: ShipClass;
  /** Optional room name (matchmaking key). Empty = lobby/default. */
  roomName: string;
  /** Master audio volume 0..1. */
  volume: number;
  /** Whether the synthwave background pad plays. */
  music: boolean;
  /** Number of times the local player earned a perfect start (display). */
  perfectStarts: number;
  phase: RoomPhase;
  countdown: number;
  startsIn: number;
  players: Record<string, PlayerInfoMsg>;
  /** Ring of recent snapshots (newest last). */
  snapshots: Snapshot[];
  racersLeft: number;
  standings: Standing[];
  /** Latest pause flag (display only — server keeps simulating). */
  paused: boolean;
  /** Pong RTT (ms) for latency display. */
  rttMs: number | null;
  /** Last error to display in a banner. */
  error: string | null;
  /** KOs the local player has scored — retained briefly so the HUD can show them. */
  myKos: readonly { id: string; at: number }[];
  /** Recent pickup events — retained briefly so the renderer can spawn FX. */
  pickupEvents: readonly PickupEvent[];
  /** Last N KOs in chronological order — surfaced on the results screen. */
  koLog: readonly KoLogEntry[];
  /** Recent hit events from the server — drives world-space impact FX. */
  hitEvents: readonly HitEvent[];
};

export const buildInitialClientState = (): ClientState => ({
  view: 'menu',
  status: 'idle',
  pseudo: '',
  color: '#3aa0ff',
  myId: null,
  trackId: 'mute-avenue',
  cls: 'balanced',
  roomName: '',
  volume: 0.6,
  music: true,
  perfectStarts: 0,
  phase: 'WAITING',
  countdown: 0,
  startsIn: -1,
  players: {},
  snapshots: [],
  racersLeft: 99,
  standings: [],
  paused: false,
  rttMs: null,
  error: null,
  myKos: [],
  pickupEvents: [],
  koLog: [],
  hitEvents: [],
});

export type Action =
  | { type: 'SET_PSEUDO'; pseudo: string }
  | { type: 'SET_COLOR'; color: string }
  | { type: 'SET_TRACK'; trackId: string }
  | { type: 'SET_ROOM'; roomName: string }
  | { type: 'SET_CLASS'; cls: ShipClass }
  | { type: 'SET_VOLUME'; volume: number }
  | { type: 'SET_MUSIC'; music: boolean }
  | { type: 'CONNECTING' }
  | { type: 'CONNECTED' }
  | { type: 'DISCONNECTED' }
  | { type: 'CONNECTION_ERROR'; error: string }
  | { type: 'SET_VIEW'; view: ClientState['view'] }
  | { type: 'TOGGLE_PAUSE' }
  | { type: 'SERVER_MESSAGE'; message: ServerMessage; receivedAt: number }
  | { type: 'CLEAR_ERROR' };

const MAX_SNAPSHOTS = 6;

export const reducer = (state: ClientState, action: Action): ClientState => {
  switch (action.type) {
    case 'SET_PSEUDO':
      return { ...state, pseudo: action.pseudo };
    case 'SET_COLOR':
      return { ...state, color: action.color };
    case 'SET_TRACK':
      return { ...state, trackId: action.trackId };
    case 'SET_ROOM':
      return { ...state, roomName: action.roomName };
    case 'SET_CLASS':
      return { ...state, cls: action.cls };
    case 'SET_VOLUME':
      return { ...state, volume: Math.max(0, Math.min(1, action.volume)) };
    case 'SET_MUSIC':
      return { ...state, music: action.music };
    case 'CONNECTING':
      return { ...state, status: 'connecting', error: null };
    case 'CONNECTED':
      return { ...state, status: 'connected' };
    case 'DISCONNECTED':
      return {
        ...state,
        status: 'closed',
        view: 'menu',
        myId: null,
        snapshots: [],
        paused: false,
        koLog: [],
        hitEvents: [],
      };
    case 'CONNECTION_ERROR':
      return { ...state, status: 'error', error: action.error, view: 'menu' };
    case 'SET_VIEW':
      return { ...state, view: action.view };
    case 'TOGGLE_PAUSE':
      return { ...state, paused: !state.paused };
    case 'CLEAR_ERROR':
      return { ...state, error: null };
    case 'SERVER_MESSAGE':
      return applyServer(state, action.message, action.receivedAt);
  }
};

const applyServer = (
  state: ClientState,
  msg: ServerMessage,
  now: number,
): ClientState => {
  switch (msg.type) {
    case 'welcome': {
      const players: Record<string, PlayerInfoMsg> = {};
      for (const p of msg.players) players[p.id] = p;
      return {
        ...state,
        myId: msg.yourId,
        trackId: msg.track,
        phase: msg.phase,
        countdown: msg.countdown,
        startsIn: msg.startsIn,
        players,
        view: msg.phase === 'WAITING' ? 'lobby' : 'race',
      };
    }
    case 'players': {
      const players: Record<string, PlayerInfoMsg> = {};
      for (const p of msg.players) players[p.id] = p;
      return { ...state, players };
    }
    case 'phase': {
      const next: ClientState = {
        ...state,
        phase: msg.phase,
        countdown: msg.countdown ?? state.countdown,
        startsIn: msg.startsIn ?? state.startsIn,
      };
      if (msg.phase === 'COUNTDOWN' || msg.phase === 'RACING') next.view = 'race';
      if (msg.phase === 'FINISHED') next.view = 'results';
      return next;
    }
    case 'snapshot': {
      const snap: Snapshot = {
        tick: msg.tick,
        time: msg.time,
        receivedAt: now,
        ships: msg.ships,
        racersLeft: msg.racersLeft,
        pk: msg.pk,
      };
      const snapshots = [...state.snapshots, snap].slice(-MAX_SNAPSHOTS);
      // Garbage collect stale myKos popups (older than 2s).
      const cutoff = now - 2000;
      const myKos = state.myKos.some((k) => k.at <= cutoff)
        ? state.myKos.filter((k) => k.at > cutoff)
        : state.myKos;
      const peCutoff = now - 800;
      const pickupEvents = state.pickupEvents.some((e) => e.at <= peCutoff)
        ? state.pickupEvents.filter((e) => e.at > peCutoff)
        : state.pickupEvents;
      return { ...state, snapshots, racersLeft: msg.racersLeft, myKos, pickupEvents };
    }
    case 'pickup': {
      const peCutoff = now - 800;
      const fresh = state.pickupEvents.filter((e) => e.at > peCutoff);
      return {
        ...state,
        pickupEvents: [
          ...fresh,
          { idx: msg.idx, kind: msg.kind, vehicleId: msg.vehicleId, at: now },
        ],
      };
    }
    case 'hit': {
      const cutoff = now - 800;
      const fresh = state.hitEvents.filter((e) => e.at > cutoff);
      return {
        ...state,
        hitEvents: [
          ...fresh,
          {
            victim: msg.victim,
            attacker: msg.attacker,
            kind: msg.kind,
            x: msg.x,
            y: msg.y,
            at: now,
          },
        ],
      };
    }
    case 'ko': {
      // Drop popups older than 2s.
      const cutoff = now - 2000;
      const fresh = state.myKos.filter((k) => k.at > cutoff);
      // Capture the victim's position from the latest snapshot for the
      // results-screen recap.
      const last = state.snapshots[state.snapshots.length - 1];
      const victim = last?.ships.find((s) => s.id === msg.id);
      const entry: KoLogEntry = {
        id: msg.id,
        by: msg.by,
        time: msg.time,
        x: victim ? victim.x : null,
        y: victim ? victim.y : null,
      };
      const koLog = [...state.koLog, entry].slice(-12);
      const next: ClientState = { ...state, koLog };
      if (msg.by === state.myId) {
        next.myKos = [...fresh, { id: msg.id, at: now }];
      } else if (fresh.length !== state.myKos.length) {
        next.myKos = fresh;
      }
      return next;
    }
    case 'results':
      return {
        ...state,
        standings: msg.standings,
        view: 'results',
        phase: 'FINISHED',
      };
    case 'perfect-start':
      // Bump local counter only when it's the local player.
      if (msg.id === state.myId) {
        return { ...state, perfectStarts: state.perfectStarts + 1 };
      }
      return state;
    case 'pong':
      return { ...state, rttMs: now - msg.ts };
  }
};

/** Find this client's ship in the latest snapshot. Useful for HUD. */
export const findMyShip = (state: ClientState): ShipSnapshot | null => {
  if (!state.myId) return null;
  const last = state.snapshots[state.snapshots.length - 1];
  if (!last) return null;
  return last.ships.find((s) => s.id === state.myId) ?? null;
};

/** Compute current race position 1..N for this client based on latest snapshot. */
export const myPosition = (state: ClientState): number | null => {
  if (!state.myId) return null;
  const last = state.snapshots[state.snapshots.length - 1];
  if (!last) return null;
  const sorted = [...last.ships].sort((a, b) => b.a - a.a);
  const idx = sorted.findIndex((s) => s.id === state.myId);
  return idx >= 0 ? idx + 1 : null;
};

export type LeaderboardEntry = {
  readonly position: number;
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly bot: boolean;
  /** Arc length gap to the leader (always >= 0). */
  readonly gap: number;
  /** True if this row is the local player. */
  readonly isMe: boolean;
  /** True for KO'd or finished ships (rendered dim). */
  readonly inactive: boolean;
};

/**
 * Compute the live race leaderboard from the latest snapshot.
 * Returns the top N (default 3); if the local player isn't in the top N,
 * their row is appended at the end with their actual position.
 */
export const liveLeaderboard = (
  state: ClientState,
  topN = 3,
): LeaderboardEntry[] => {
  const last = state.snapshots[state.snapshots.length - 1];
  if (!last || last.ships.length === 0) return [];
  const sorted = [...last.ships].sort((a, b) => b.a - a.a);
  const leaderArc = sorted[0]?.a ?? 0;
  const rows: LeaderboardEntry[] = sorted.map((s, i) => {
    const player = state.players[s.id];
    return {
      position: i + 1,
      id: s.id,
      name: player?.name ?? s.id,
      color: player?.color ?? '#888',
      bot: player?.bot ?? true,
      gap: Math.max(0, leaderArc - s.a),
      isMe: s.id === state.myId,
      inactive: (s.f & 4) !== 0 /* FLAG_KO */ || (s.f & 8) !== 0 /* FLAG_FINISHED */,
    };
  });
  const top = rows.slice(0, topN);
  const meIdx = rows.findIndex((r) => r.isMe);
  if (meIdx >= topN) {
    top.push(rows[meIdx] as LeaderboardEntry);
  }
  return top;
};

/** Find the id of the ship the spectator camera should follow (alive leader). */
export const spectatorTargetId = (state: ClientState): string | null => {
  const last = state.snapshots[state.snapshots.length - 1];
  if (!last) return null;
  let bestId: string | null = null;
  let bestArc = -Infinity;
  for (const s of last.ships) {
    if ((s.f & 4) !== 0) continue; // FLAG_KO
    if (s.a > bestArc) {
      bestArc = s.a;
      bestId = s.id;
    }
  }
  return bestId;
};
