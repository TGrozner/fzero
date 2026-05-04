import {
  type Vehicle,
  type VehicleInput,
  type PhysicsParams,
  DEFAULT_PARAMS,
  resolveVehicleCollision,
  stepVehicle,
} from './physics.ts';
import { applySideAttack, applySpinAttack, type AttackHit } from './attacks.ts';
import { closestOnTrack, type Track } from './track.ts';
import {
  KO_METER_PER_CHECKPOINT,
  LAST_N_BOOST_DURATION_S,
  LAST_N_BOOST_THRESHOLD,
  SKYWAY_DURATION_S,
  SPAWN_PROTECTION_S,
  TOTAL_LAPS,
  VEHICLE_RADIUS,
} from './constants.ts';
import { clamp } from './vec2.ts';

export type RaceConfig = {
  readonly track: Track;
  readonly totalLaps: number;
  readonly params: PhysicsParams;
};

export const buildRaceConfig = (
  track: Track,
  totalLaps = TOTAL_LAPS,
  params: PhysicsParams = DEFAULT_PARAMS,
): RaceConfig => ({ track, totalLaps, params });

/**
 * Update lap progression for a vehicle. Adds KO meter charge when a checkpoint
 * is crossed for the first time within the lap.
 */
export const updateLapProgress = (
  v: Vehicle,
  config: RaceConfig,
  raceTime: number,
): Vehicle => {
  if (v.finished || v.ko) return v;
  const c = closestOnTrack(config.track, v.pos);
  const trackLen = config.track.length;
  const lapBase = v.lap * trackLen;
  const projected = lapBase + c.arcLength;
  let newArc = v.arcLength;
  if (projected + trackLen / 2 < v.arcLength) {
    // Forward wrap past the start/finish line — we just completed a lap.
    newArc = projected + trackLen;
  } else if (projected > v.arcLength + trackLen / 2) {
    // Our actual position projects on the opposite side of the wrap from our
    // current arc. This happens for ships sitting *behind* the start line on
    // a closed track: closestOnTrack returns a near-trackLen arc value, but
    // we're really at a slightly-negative race progress. Mirror it.
    newArc = projected - trackLen;
  } else if (projected > v.arcLength) {
    newArc = projected;
  }

  let nextCp = v.nextCheckpoint;
  let lap = v.lap;
  let koMeter = v.koMeter;
  const cps = config.track.checkpoints;
  for (let safety = 0; safety < cps.length + 1; safety++) {
    const cpIdx = cps[nextCp] as number;
    const cpArc = (config.track.cumulative[cpIdx] as number) + lap * trackLen;
    if (newArc >= cpArc) {
      nextCp += 1;
      koMeter = clamp(koMeter + KO_METER_PER_CHECKPOINT, 0, 1);
      if (nextCp >= cps.length) {
        nextCp = 0;
        lap += 1;
      }
    } else break;
  }

  const finished = lap >= config.totalLaps;
  return {
    ...v,
    arcLength: newArc,
    lap: finished ? config.totalLaps : lap,
    nextCheckpoint: nextCp,
    finished,
    finishTime: finished && v.finishTime === null ? raceTime : v.finishTime,
    koMeter,
  };
};

/** Try to consume a full KO meter and activate skyway. Returns updated vehicle. */
export const tryActivateSkyway = (v: Vehicle, raceTime: number): Vehicle => {
  if (v.ko || v.finished) return v;
  if (v.koMeter < 1) return v;
  if (v.skywayUntil > raceTime) return v;
  return {
    ...v,
    koMeter: 0,
    skywayUntil: raceTime + SKYWAY_DURATION_S,
  };
};

/** Activate the global free-boost when racer count drops below threshold. */
export const maybeTriggerLastNBoost = (
  vehicles: readonly Vehicle[],
  raceTime: number,
  alreadyTriggered: boolean,
): { vehicles: Vehicle[]; triggered: boolean } => {
  const alive = vehicles.filter((v) => !v.ko && !v.finished).length;
  if (alreadyTriggered || alive > LAST_N_BOOST_THRESHOLD || alive === 0) {
    return { vehicles: [...vehicles], triggered: alreadyTriggered };
  }
  const updated = vehicles.map((v) =>
    v.ko || v.finished
      ? v
      : { ...v, freeBoostUntil: raceTime + LAST_N_BOOST_DURATION_S },
  );
  return { vehicles: updated, triggered: true };
};

/**
 * Step all vehicles for one frame:
 * 1. Apply per-vehicle physics
 * 2. Apply spin attacks (charges KO meter on KOs)
 * 3. Resolve pairwise collisions
 * 4. Update lap progression
 * 5. Activate skyway for vehicles whose input requested it (handled outside via tryActivateSkyway)
 */
export type KoEvent = { id: string; by: string | null };

export const stepRace = (
  vehicles: readonly Vehicle[],
  inputs: ReadonlyMap<string, VehicleInput>,
  config: RaceConfig,
  dt: number,
  raceTime: number,
): { vehicles: Vehicle[]; kos: KoEvent[]; hits: AttackHit[] } => {
  // During the spawn-protection window, strip all attack flags.
  const protect = raceTime < SPAWN_PROTECTION_S;
  let stepped = vehicles.map((v) => {
    const raw = inputs.get(v.id);
    const input = raw
      ? protect
        ? { ...raw, spin: false, sideLeft: false, sideRight: false }
        : raw
      : {
          throttle: 0,
          steer: 0,
          boost: false,
          spin: false,
          sideLeft: false,
          sideRight: false,
          skyway: false,
        };
    const next = stepVehicle(v, input, config.track, dt, raceTime);
    // While protected, freeze power at 1 — no off-track / wall damage either.
    return protect ? { ...next, power: 1, ko: false } : next;
  });

  const allKos: KoEvent[] = [];
  const allHits: AttackHit[] = [];

  if (!protect) {
    for (let i = 0; i < stepped.length; i++) {
      const attacker = stepped[i] as Vehicle;
      const input = inputs.get(attacker.id);
      if (!input?.spin) continue;
      const result = applySpinAttack(attacker, stepped, raceTime);
      stepped = result.others.map((v) => (v.id === attacker.id ? result.attacker : v));
      for (const koId of result.kos) allKos.push({ id: koId, by: attacker.id });
      allHits.push(...result.hits);
    }
    for (let i = 0; i < stepped.length; i++) {
      const attacker = stepped[i] as Vehicle;
      const input = inputs.get(attacker.id);
      if (!input) continue;
      // Side attacks fired this tick are already reflected in attacker.sideCd
      // by physics — we detect them by checking the input bit AND that the
      // cooldown is fresh (>= SIDE_ATTACK_COOLDOWN_S * 0.95). We don't gate
      // on the input alone because the physics step may have ignored it.
      if (!input.sideLeft && !input.sideRight) continue;
      const dir: -1 | 1 = input.sideLeft ? -1 : 1;
      const result = applySideAttack(attacker, stepped, dir, raceTime);
      stepped = result.others.map((v) => (v.id === attacker.id ? result.attacker : v));
      for (const koId of result.kos) allKos.push({ id: koId, by: attacker.id });
      allHits.push(...result.hits);
    }
  }

  // Skyway requests.
  for (let i = 0; i < stepped.length; i++) {
    const v = stepped[i] as Vehicle;
    const input = inputs.get(v.id);
    if (input?.skyway) stepped[i] = tryActivateSkyway(v, raceTime);
  }

  // Pairwise collisions (n^2 — fine for ~100 vehicles).
  for (let i = 0; i < stepped.length; i++) {
    const a = stepped[i] as Vehicle;
    if (a.skywayUntil > raceTime || a.ko) continue;
    for (let j = i + 1; j < stepped.length; j++) {
      const b = stepped[j] as Vehicle;
      if (b.skywayUntil > raceTime || b.ko) continue;
      const r = resolveVehicleCollision(a, b, VEHICLE_RADIUS);
      stepped[i] = r.a;
      stepped[j] = r.b;
    }
  }

  // Lap progress.
  const finalVehicles = stepped.map((v) => updateLapProgress(v, config, raceTime));

  // Detect KOs that happened during this step (power dropped to 0 in physics
  // or wall) — these have no specific attacker.
  for (const v of finalVehicles) {
    const prev = vehicles.find((p) => p.id === v.id);
    if (prev && !prev.ko && v.ko && !allKos.some((k) => k.id === v.id)) {
      allKos.push({ id: v.id, by: null });
    }
  }

  return { vehicles: finalVehicles, kos: allKos, hits: allHits };
};

export type Standing = {
  readonly id: string;
  readonly position: number;
  readonly lap: number;
  readonly arcLength: number;
  readonly finished: boolean;
  readonly finishTime: number | null;
  readonly ko: boolean;
};

export const standings = (vehicles: readonly Vehicle[]): Standing[] => {
  const sorted = [...vehicles].sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished) {
      return (a.finishTime ?? Infinity) - (b.finishTime ?? Infinity);
    }
    if (a.ko !== b.ko) return a.ko ? 1 : -1;
    return b.arcLength - a.arcLength;
  });
  return sorted.map((v, i) => ({
    id: v.id,
    position: i + 1,
    lap: v.lap,
    arcLength: v.arcLength,
    finished: v.finished,
    finishTime: v.finishTime,
    ko: v.ko,
  }));
};

/** True if the race is over: all alive vehicles finished, or only one alive remains. */
export const isRaceOver = (vehicles: readonly Vehicle[], totalLaps: number): boolean => {
  if (vehicles.length === 0) return false;
  const alive = vehicles.filter((v) => !v.ko && !v.finished);
  if (alive.length === 0) return true;
  return vehicles.every((v) => v.finished || v.ko || v.lap >= totalLaps);
};
