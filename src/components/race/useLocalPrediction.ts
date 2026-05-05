import { useEffect, useRef } from 'react';
import { stepVehicle, type Vehicle, type VehicleInput } from '../../../shared/physics.ts';
import {
  FLAG_FINISHED,
  FLAG_FREE_BOOST,
  FLAG_KO,
  FLAG_SKYWAY,
  type ShipSnapshot,
} from '../../../shared/protocol.ts';
import { lerpAngle } from '../../../shared/vec2.ts';
import { findTrack } from '../../../shared/track.ts';
import type { ShipClass } from '../../../shared/constants.ts';
import type { ClientState } from '../../state.ts';
import type { ShipPose } from '../../render/renderer.ts';

/**
 * Build a Vehicle from a ShipSnapshot. Snapshots are intentionally compact and
 * drop fields that don't matter for rendering (nextCheckpoint, koTime,
 * finishTime, exact skywayUntil) — for prediction we just need the kinematic
 * + gameplay flags. The remaining fields are seeded with sane defaults; the
 * server snapshot continues to carry the authoritative game state and we
 * refresh those fields on every reconcile.
 *
 * Exported only for unit testing.
 */
export const _vehicleFromSnapshot = (
  s: ShipSnapshot,
  cls: ShipClass,
  raceTime: number,
): Vehicle => ({
  id: s.id,
  cls,
  pos: { x: s.x, y: s.y },
  vel: { x: s.vx, y: s.vy },
  heading: s.h,
  power: s.p,
  koMeter: s.k,
  arcLength: s.a,
  lap: s.l,
  // We don't know the exact next checkpoint client-side; server is
  // authoritative on lap/arcLength so close approximations are fine.
  nextCheckpoint: 0,
  finished: (s.f & FLAG_FINISHED) !== 0,
  finishTime: null,
  ko: (s.f & FLAG_KO) !== 0,
  koTime: null,
  // We don't know exactly when skyway/freeboost end. Approximate: while the
  // flag is set, give ourselves up to 1 s. Each reconcile refreshes from the
  // server, so the predicted "ends in 1 s" never gets a chance to drift more
  // than one tick (~100 ms) before being corrected.
  skywayUntil: (s.f & FLAG_SKYWAY) !== 0 ? raceTime + 1.0 : 0,
  freeBoostUntil: (s.f & FLAG_FREE_BOOST) !== 0 ? raceTime + 1.0 : 0,
  spinCd: s.sc,
  sideCd: s.dc,
});

/**
 * Hard-snap thresholds — large divergence between server and client means
 * something physically dramatic happened (collision, spin attack, KO) that
 * the client couldn't predict. Reset the local state instead of trying to
 * lerp through it.
 */
const HARD_SNAP_DISTANCE = 35;

/**
 * Soft-correction lerp factor applied on every snapshot. With 10 Hz snapshots
 * we get 10 corrections per second, so 0.18 per snap pulls ~85 % of the way
 * to the server in 1 s — fast enough to keep client tightly paired but slow
 * enough to be invisible at the wheel.
 */
const SOFT_CORRECT_LERP = 0.18;

/** Minimum positional error (units) below which we just accept the local state. */
const ACCEPT_BAND = 1.5;

/** Exported only for unit testing. */
export const _reconcile = (
  v: Vehicle,
  s: ShipSnapshot,
  raceTime: number,
): Vehicle => {
  const dx = s.x - v.pos.x;
  const dy = s.y - v.pos.y;
  const err = Math.hypot(dx, dy);
  // Always refresh the "authoritative" fields from the server — these are
  // either game-rule outcomes (ko, lap, arcLength), values the client can't
  // recompute correctly without other vehicles' state (koMeter via attacks),
  // or velocity (for which the server already accounts for collisions and
  // attack impulses we don't simulate locally).
  const auth: Partial<Vehicle> = {
    power: s.p,
    koMeter: s.k,
    arcLength: s.a,
    lap: s.l,
    finished: (s.f & FLAG_FINISHED) !== 0,
    ko: (s.f & FLAG_KO) !== 0,
    spinCd: s.sc,
    sideCd: s.dc,
    skywayUntil: (s.f & FLAG_SKYWAY) !== 0 ? raceTime + 1.0 : 0,
    freeBoostUntil: (s.f & FLAG_FREE_BOOST) !== 0 ? raceTime + 1.0 : 0,
    vel: { x: s.vx, y: s.vy },
  };
  if (err > HARD_SNAP_DISTANCE) {
    // Hard snap — collision, KO, server placed us somewhere we couldn't
    // predict. Smoother to reset cleanly than to lerp-track an impossible gap.
    return {
      ...v,
      ...auth,
      pos: { x: s.x, y: s.y },
      heading: s.h,
    };
  }
  if (err < ACCEPT_BAND) {
    // Server agrees with our prediction — keep our local kinematics and just
    // refresh authoritative fields.
    return { ...v, ...auth };
  }
  // Soft correct: lerp position/heading toward server.
  return {
    ...v,
    ...auth,
    pos: {
      x: v.pos.x + dx * SOFT_CORRECT_LERP,
      y: v.pos.y + dy * SOFT_CORRECT_LERP,
    },
    heading: lerpAngle(v.heading, s.h, SOFT_CORRECT_LERP),
  };
};

/** Exported only for unit testing. */
export const _poseFromVehicle = (v: Vehicle, raceTime: number): ShipPose => {
  let f = 0;
  if (v.skywayUntil > raceTime) f |= FLAG_SKYWAY;
  if (v.freeBoostUntil > raceTime) f |= FLAG_FREE_BOOST;
  if (v.ko) f |= FLAG_KO;
  if (v.finished) f |= FLAG_FINISHED;
  return {
    x: v.pos.x,
    y: v.pos.y,
    h: v.heading,
    vx: v.vel.x,
    vy: v.vel.y,
    flags: f,
  };
};

export type LocalPrediction = {
  /** Step the local vehicle by `dt` seconds with the given input. */
  step: (dt: number, input: VehicleInput) => void;
  /** Current predicted pose for the renderer (null while not in a race). */
  pose: () => ShipPose | null;
};

/**
 * Owns the locally-predicted Vehicle for the player's own ship. Initialises
 * from the first snapshot once we're racing, steps each render frame in
 * `step`, and reconciles against incoming server snapshots so the client
 * never drifts far from the authoritative state.
 *
 * The renderer's `localOverride` parameter takes the result of `pose()`. The
 * player's own ship is therefore decoupled from the snapshot interpolation
 * pipeline (which is still used for everyone else) and reacts to input every
 * single frame, not every tick.
 */
export const useLocalPrediction = (state: ClientState): LocalPrediction => {
  const vehicleRef = useRef<Vehicle | null>(null);
  const raceTimeRef = useRef(0);
  const lastSnapshotRef = useRef<ClientState['snapshots'][number] | null>(null);

  // Reset on phase / identity changes so a new race starts clean.
  useEffect(() => {
    if (state.phase !== 'COUNTDOWN' && state.phase !== 'RACING') {
      vehicleRef.current = null;
      raceTimeRef.current = 0;
      lastSnapshotRef.current = null;
    }
  }, [state.phase]);
  useEffect(() => {
    vehicleRef.current = null;
    raceTimeRef.current = 0;
    lastSnapshotRef.current = null;
  }, [state.myId]);

  // Reconcile / initialise on each new snapshot.
  useEffect(() => {
    if (!state.myId) return;
    const newest = state.snapshots[state.snapshots.length - 1];
    if (!newest || newest === lastSnapshotRef.current) return;
    lastSnapshotRef.current = newest;
    const myShip = newest.ships.find((s) => s.id === state.myId);
    if (!myShip) return;
    raceTimeRef.current = newest.time;
    if (!vehicleRef.current) {
      vehicleRef.current = _vehicleFromSnapshot(myShip, state.cls, newest.time);
    } else {
      vehicleRef.current = _reconcile(vehicleRef.current, myShip, newest.time);
    }
  }, [state.snapshots, state.myId, state.cls]);

  return {
    step: (dt, input) => {
      const v = vehicleRef.current;
      if (!v) return;
      // Predict ONLY during RACING. In COUNTDOWN the server runs no physics
      // (vehicles are pinned to their grid positions), so simulating locally
      // with the user's throttle held would visibly slide the ship forward
      // before the GO and ruin the perfect-start visual.
      if (state.phase !== 'RACING') return;
      const track = findTrack(state.trackId);
      raceTimeRef.current += dt;
      vehicleRef.current = stepVehicle(v, input, track, dt, raceTimeRef.current);
    },
    pose: () => {
      const v = vehicleRef.current;
      if (!v) return null;
      return _poseFromVehicle(v, raceTimeRef.current);
    },
  };
};
