import type { RoomPhase } from '../shared/constants.ts';
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
  /** Optional room name (matchmaking key). Empty = lobby/default. */
  roomName: string;
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
};

export const buildInitialClientState = (): ClientState => ({
  view: 'menu',
  status: 'idle',
  pseudo: '',
  color: '#3aa0ff',
  myId: null,
  trackId: 'mute-avenue',
  roomName: '',
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
});

export type Action =
  | { type: 'SET_PSEUDO'; pseudo: string }
  | { type: 'SET_COLOR'; color: string }
  | { type: 'SET_TRACK'; trackId: string }
  | { type: 'SET_ROOM'; roomName: string }
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
    case 'CONNECTING':
      return { ...state, status: 'connecting', error: null };
    case 'CONNECTED':
      return { ...state, status: 'connected' };
    case 'DISCONNECTED':
      return { ...state, status: 'closed', view: 'menu', myId: null, snapshots: [], paused: false };
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
    case 'ko': {
      // Drop popups older than 2s.
      const cutoff = now - 2000;
      const fresh = state.myKos.filter((k) => k.at > cutoff);
      if (msg.by !== state.myId) {
        return fresh.length === state.myKos.length ? state : { ...state, myKos: fresh };
      }
      return { ...state, myKos: [...fresh, { id: msg.id, at: now }] };
    }
    case 'results':
      return {
        ...state,
        standings: msg.standings,
        view: 'results',
        phase: 'FINISHED',
      };
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
