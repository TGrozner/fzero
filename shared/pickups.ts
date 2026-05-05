import { type Vec2, add, sub, scale, normalize, perp, clamp } from './vec2.ts';
import type { Track } from './track.ts';
import type { Vehicle } from './physics.ts';

export type PickupKind = 'boost' | 'heal' | 'mine';

export type PickupSpec = {
  readonly kind: PickupKind;
  /** Arc length along the centerline. */
  readonly arc: number;
  /** Lateral offset, signed fraction of halfWidth (-1..+1). */
  readonly lateral: number;
};

/** World-units pickup hitbox radius. ~13 lines up with the renderer's
 *  visible disc + halo so what you SEE is what you HIT — players were
 *  clipping past pads they thought they'd grabbed at 7. */
export const PICKUP_RADIUS = 13;
export const PICKUP_RESPAWN_S = 5;

export const BOOST_PICKUP_POWER = 0.18;
export const BOOST_PICKUP_DURATION_S = 1.5;
export const HEAL_PICKUP_POWER = 0.35;
export const MINE_PICKUP_DAMAGE = 0.3;

/**
 * Authored pickup layout for a track. Returns a deterministic set of pads
 * spaced around the centerline with mixed kinds.
 */
export const defaultPickups = (track: Track): PickupSpec[] => {
  const out: PickupSpec[] = [];
  const L = track.length;
  // 6 boost pads, mostly centred (slightly staggered).
  for (let i = 0; i < 6; i++) {
    const arc = ((i + 0.1) / 6) * L;
    out.push({ kind: 'boost', arc, lateral: i % 2 === 0 ? -0.2 : 0.2 });
  }
  // 4 heal plates, off to the sides so you have to reach for them.
  for (let i = 0; i < 4; i++) {
    const arc = ((i + 0.5) / 4) * L;
    out.push({ kind: 'heal', arc, lateral: i % 2 === 0 ? -0.6 : 0.6 });
  }
  // 4 mines, in the racing line.
  for (let i = 0; i < 4; i++) {
    const arc = ((i + 0.25) / 4) * L + 24;
    out.push({ kind: 'mine', arc, lateral: i % 2 === 0 ? 0.45 : -0.45 });
  }
  return out;
};

/** World-space position of a pickup. */
export const pickupWorldPos = (track: Track, spec: PickupSpec): Vec2 => {
  const arc = ((spec.arc % track.length) + track.length) % track.length;
  for (let i = 0; i < track.centerline.length; i++) {
    const start = track.cumulative[i] as number;
    const end = track.cumulative[i + 1] as number;
    if (arc >= start && arc <= end) {
      const segLen = end - start;
      const t = segLen === 0 ? 0 : (arc - start) / segLen;
      const a = track.centerline[i] as Vec2;
      const b = track.centerline[(i + 1) % track.centerline.length] as Vec2;
      const tangent = normalize(sub(b, a));
      const normal = perp(tangent);
      const center = add(a, scale(sub(b, a), t));
      return add(center, scale(normal, spec.lateral * track.halfWidth));
    }
  }
  return track.startPosition;
};

export type PickupHit = {
  readonly idx: number;
  readonly kind: PickupKind;
  readonly vehicleId: string;
};

/**
 * Resolve pickup collisions for the current frame.
 * Pure: returns updated vehicles, updated respawn timestamps, and a list of hit events.
 *
 * `respawnAt[i]` > `raceTime` means the pad is consumed; ≤ means it's active.
 */
export const applyPickups = (
  vehicles: readonly Vehicle[],
  layout: readonly PickupSpec[],
  positions: readonly Vec2[],
  respawnAt: readonly number[],
  raceTime: number,
): {
  vehicles: Vehicle[];
  respawnAt: number[];
  hits: PickupHit[];
  kos: string[];
} => {
  const out = vehicles.map((v) => v);
  const newRespawn = [...respawnAt];
  const hits: PickupHit[] = [];
  const kos: string[] = [];
  const r2 = PICKUP_RADIUS * PICKUP_RADIUS;
  for (let i = 0; i < layout.length; i++) {
    if ((newRespawn[i] ?? 0) > raceTime) continue;
    const pos = positions[i] as Vec2;
    const spec = layout[i] as PickupSpec;
    for (let j = 0; j < out.length; j++) {
      const v = out[j] as Vehicle;
      if (v.ko || v.finished) continue;
      if (v.skywayUntil > raceTime) continue;
      const dx = v.pos.x - pos.x;
      const dy = v.pos.y - pos.y;
      if (dx * dx + dy * dy > r2) continue;
      // Hit.
      hits.push({ idx: i, kind: spec.kind, vehicleId: v.id });
      newRespawn[i] = raceTime + PICKUP_RESPAWN_S;
      if (spec.kind === 'boost') {
        out[j] = {
          ...v,
          power: clamp(v.power + BOOST_PICKUP_POWER, 0, 1),
          freeBoostUntil: Math.max(v.freeBoostUntil, raceTime + BOOST_PICKUP_DURATION_S),
        };
      } else if (spec.kind === 'heal') {
        out[j] = { ...v, power: clamp(v.power + HEAL_PICKUP_POWER, 0, 1) };
      } else {
        const newPower = clamp(v.power - MINE_PICKUP_DAMAGE, 0, 1);
        const ko = newPower <= 0;
        out[j] = {
          ...v,
          power: newPower,
          ko,
          koTime: ko && v.koTime === null ? raceTime : v.koTime,
        };
        if (ko && !v.ko) kos.push(v.id);
      }
      // Pad consumed; stop checking other vehicles for this pad this frame.
      break;
    }
  }
  return { vehicles: out, respawnAt: newRespawn, hits, kos };
};
