import type { RoomPhase } from './constants.ts';
import type { Vec2 } from './vec2.ts';

/** Compact ship state for snapshots. */
export type ShipSnapshot = {
  /** Player or bot id. */
  readonly id: string;
  /** x position. */
  readonly x: number;
  /** y position. */
  readonly y: number;
  /** Heading radians. */
  readonly h: number;
  /** Velocity x. */
  readonly vx: number;
  /** Velocity y. */
  readonly vy: number;
  /** Power 0..1. */
  readonly p: number;
  /** KO meter 0..1. */
  readonly k: number;
  /** Lap (0-based). */
  readonly l: number;
  /** Cumulative arc length around the track. */
  readonly a: number;
  /** Flags bitmask: 1=skyway, 2=freeBoost, 4=ko, 8=finished. */
  readonly f: number;
  /** Spin-attack cooldown remaining (s). 0 = ready. */
  readonly sc: number;
  /** Side-attack cooldown remaining (s). 0 = ready. */
  readonly dc: number;
};

export const FLAG_SKYWAY = 1 << 0;
export const FLAG_FREE_BOOST = 1 << 1;
export const FLAG_KO = 1 << 2;
export const FLAG_FINISHED = 1 << 3;

export type PlayerInfoMsg = {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly bot: boolean;
};

/** Client → Server messages. */
export type ClientMessage =
  | { type: 'hello'; name: string; color: string; session?: string }
  | { type: 'input'; ts: number; in: InputBits }
  | { type: 'ping'; ts: number };

/** Encoded input as a tiny bit/short tuple. */
export type InputBits = {
  /** -1..+1 throttle * 100 quantized. */
  th: number;
  /** -1..+1 steer * 100 quantized. */
  st: number;
  /** Bitmask: 1=boost,2=spin,4=sideLeft,8=sideRight,16=skyway. */
  b: number;
};

export const IBIT_BOOST = 1 << 0;
export const IBIT_SPIN = 1 << 1;
export const IBIT_SIDE_LEFT = 1 << 2;
export const IBIT_SIDE_RIGHT = 1 << 3;
export const IBIT_SKYWAY = 1 << 4;

/** Server → Client messages. */
export type ServerMessage =
  | {
      type: 'welcome';
      yourId: string;
      track: string;
      players: PlayerInfoMsg[];
      phase: RoomPhase;
      countdown: number;
      startsIn: number; // seconds until auto-start (lobby), -1 if N/A
      /**
       * True if this welcome message is for a reconnecting client (their
       * previous bot-controlled vehicle is being handed back).
       */
      reconnected?: boolean;
    }
  | { type: 'players'; players: PlayerInfoMsg[] }
  | {
      type: 'snapshot';
      /** Server tick number. */
      tick: number;
      /** Server race time in seconds. */
      time: number;
      ships: ShipSnapshot[];
      racersLeft: number;
      /**
       * Bitmask of currently active pickups (pad index → bit). Up to 32 pads.
       * Layout is derived deterministically from the trackId (see pickups.ts).
       */
      pk: number;
    }
  | { type: 'phase'; phase: RoomPhase; countdown?: number; startsIn?: number }
  | { type: 'ko'; id: string; by: string | null; time: number }
  | {
      /**
       * A non-lethal hit (spin, side, or projectile-style impact). Used to
       * drive client-side feedback (particles, screen flash) at the world
       * position of the victim — independent of the per-snapshot ship
       * positions, which would smooth the impact away.
       */
      type: 'hit';
      victim: string;
      attacker: string | null;
      kind: 'spin' | 'side-left' | 'side-right' | 'wall' | 'collision';
      x: number;
      y: number;
      time: number;
    }
  | { type: 'pickup'; idx: number; kind: 'boost' | 'heal' | 'mine'; vehicleId: string; time: number }
  | {
      type: 'results';
      standings: { id: string; position: number; finishTime: number | null; ko: boolean }[];
    }
  | { type: 'pong'; ts: number };

export const encode = (m: ClientMessage | ServerMessage): string => JSON.stringify(m);

export const decodeClient = (s: string): ClientMessage | null => {
  try {
    const v = JSON.parse(s) as ClientMessage;
    if (typeof v !== 'object' || v === null || typeof (v as { type?: unknown }).type !== 'string') {
      return null;
    }
    return v;
  } catch {
    return null;
  }
};

export const decodeServer = (s: string): ServerMessage | null => {
  try {
    const v = JSON.parse(s) as ServerMessage;
    if (typeof v !== 'object' || v === null || typeof (v as { type?: unknown }).type !== 'string') {
      return null;
    }
    return v;
  } catch {
    return null;
  }
};

export const encodeInput = (input: {
  throttle: number;
  steer: number;
  boost: boolean;
  spin: boolean;
  sideLeft: boolean;
  sideRight: boolean;
  skyway: boolean;
}): InputBits => {
  let b = 0;
  if (input.boost) b |= IBIT_BOOST;
  if (input.spin) b |= IBIT_SPIN;
  if (input.sideLeft) b |= IBIT_SIDE_LEFT;
  if (input.sideRight) b |= IBIT_SIDE_RIGHT;
  if (input.skyway) b |= IBIT_SKYWAY;
  return {
    th: Math.round(Math.max(-1, Math.min(1, input.throttle)) * 100),
    st: Math.round(Math.max(-1, Math.min(1, input.steer)) * 100),
    b,
  };
};

export const decodeInput = (
  bits: InputBits,
): {
  throttle: number;
  steer: number;
  boost: boolean;
  spin: boolean;
  sideLeft: boolean;
  sideRight: boolean;
  skyway: boolean;
} => ({
  throttle: bits.th / 100,
  steer: bits.st / 100,
  boost: (bits.b & IBIT_BOOST) !== 0,
  spin: (bits.b & IBIT_SPIN) !== 0,
  sideLeft: (bits.b & IBIT_SIDE_LEFT) !== 0,
  sideRight: (bits.b & IBIT_SIDE_RIGHT) !== 0,
  skyway: (bits.b & IBIT_SKYWAY) !== 0,
});

/** Reconstruct a Vec2 position from a snapshot. */
export const snapshotPos = (s: ShipSnapshot): Vec2 => ({ x: s.x, y: s.y });
