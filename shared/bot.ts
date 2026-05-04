import {
  type Vec2,
  sub,
  length,
  dot,
  clamp,
  fromAngle,
  perp,
  wrapAngle,
  angleOf,
} from './vec2.ts';
import { closestOnTrack, lookaheadPoint, type Track } from './track.ts';
import { type Vehicle, type VehicleInput, NEUTRAL_INPUT } from './physics.ts';
import { hashString, createRng } from './rng.ts';
import type { PickupKind } from './pickups.ts';

export type ActivePickup = {
  readonly kind: PickupKind;
  readonly pos: Vec2;
};

export type BotProfile = {
  /** 0..1 — how often this bot triggers attacks. */
  readonly aggression: number;
  /** 0..1 — quality of steering / boost timing. */
  readonly skill: number;
  /** 0..1 — willingness to attempt skyway when meter is full. */
  readonly riskTaking: number;
};

export const profileFromSeed = (seed: number): BotProfile => {
  const r = createRng(seed);
  return {
    aggression: r.range(0, 1),
    skill: r.range(0.4, 1),
    riskTaking: r.range(0.2, 1),
  };
};

export const profileForId = (id: string): BotProfile => profileFromSeed(hashString(id));

/**
 * Compute the next input for a bot given its current state, the track, and other vehicles.
 * Pure function — no side effects.
 */
export const botInput = (
  bot: Vehicle,
  others: readonly Vehicle[],
  track: Track,
  profile: BotProfile,
  raceTime: number,
  pickups: readonly ActivePickup[] = [],
): VehicleInput => {
  if (bot.ko || bot.finished) return NEUTRAL_INPUT;

  const speed = length(bot.vel);
  // Lookahead distance scales with speed; better skill = more lookahead.
  const lookahead = clamp(20 + speed * (0.4 + profile.skill * 0.6), 25, 200);

  const projection = closestOnTrack(track, bot.pos);
  const targetPoint = lookaheadPoint(track, projection.arcLength, lookahead);
  const toTarget = sub(targetPoint, bot.pos);
  const desiredAngle = angleOf(toTarget);
  const angleDiff = wrapAngle(desiredAngle - bot.heading);

  // Steer proportional to angle diff. Lower-skill bots overshoot.
  const steerSensitivity = 1.5 + profile.skill * 0.5;
  let steer = clamp(angleDiff * steerSensitivity, -1, 1);

  // Slight noise: less skilled bots are jittery.
  if (profile.skill < 0.7) {
    const wobble = Math.sin(raceTime * 4 + bot.arcLength) * (1 - profile.skill) * 0.3;
    steer = clamp(steer + wobble, -1, 1);
  }

  // Throttle: full forward; brake if we're way off heading.
  let throttle = 1;
  if (Math.abs(angleDiff) > Math.PI / 2) throttle = 0.3;

  const fwd = fromAngle(bot.heading);
  const right = perp(fwd);

  // Pickup awareness: low HP → bias toward heal; high HP → bias toward
  // boost. Always nudge away from mines that lie on our path.
  let pickupSteer = 0;
  let mineSteer = 0;
  // Stronger heal pull when we're hurting; weaker boost pull when we're
  // already near full power so we don't deviate from the racing line.
  const wantHeal = bot.power < 0.55;
  const wantBoostPad = bot.power > 0.4;
  for (const pu of pickups) {
    const rel = sub(pu.pos, bot.pos);
    const dist = length(rel);
    if (dist > 36) continue;
    const ahead = dot(rel, fwd);
    if (ahead <= 0) continue; // already passed
    const lateral = dot(rel, right); // +ve = right of heading
    const lateralAbs = Math.abs(lateral);
    if (lateralAbs > 18) continue; // not really on our path
    // Positive steer rotates CCW, which in our convention is "right of
    // heading" (perp((1,0)) = (0,1)). So +sign(lateral) = TOWARD the pad.
    const towardPad = Math.sign(lateral);
    const proximity = 1 - dist / 36;
    if (pu.kind === 'mine') {
      // Steer AWAY from mines.
      mineSteer += -towardPad * proximity * 0.9 * (0.6 + profile.skill * 0.5);
    } else if (pu.kind === 'heal' && wantHeal) {
      const need = (1 - bot.power) * 1.4; // 0..~1.5 weight
      pickupSteer += towardPad * proximity * need * (0.5 + profile.skill * 0.4);
    } else if (pu.kind === 'boost' && wantBoostPad) {
      pickupSteer += towardPad * proximity * 0.45 * (0.4 + profile.skill * 0.5);
    }
  }

  // Avoid the nearest other vehicle directly in front.
  let avoidSteer = 0;
  for (const o of others) {
    if (o.id === bot.id || o.ko) continue;
    const rel = sub(o.pos, bot.pos);
    const dist = length(rel);
    if (dist > 25) continue;
    const forwardDot = dot(rel, fwd);
    if (forwardDot <= 0) continue; // behind us
    const lateralDot = dot(rel, right);
    avoidSteer += -Math.sign(lateralDot) * (1 - dist / 25) * 0.6;
  }
  steer = clamp(steer + avoidSteer + pickupSteer + mineSteer, -1, 1);

  // Boost when conditions are favorable: heading aligned + plenty of power.
  const aligned = Math.abs(angleDiff) < 0.25;
  const wantBoost = aligned && bot.power > 0.55 && profile.skill > 0.4;

  // Spin attack when there is an enemy very close in front.
  // Per-frame trigger rate is scaled down so even fully-aggressive bots only
  // fire ~1-2 times per second, instead of 27 times like the raw probability.
  let spin = false;
  if (bot.spinCd <= 0) {
    for (const o of others) {
      if (o.id === bot.id || o.ko || o.skywayUntil > raceTime) continue;
      const rel = sub(o.pos, bot.pos);
      const dist = length(rel);
      if (dist > 12) continue;
      const forwardDot = dot(rel, fwd);
      if (forwardDot < 0) continue;
      if (Math.random() < profile.aggression * 0.04) {
        spin = true;
        break;
      }
    }
  }

  // Side attack if a target is right beside us.
  let sideLeft = false;
  let sideRight = false;
  if (bot.sideCd <= 0 && profile.aggression > 0.4) {
    for (const o of others) {
      if (o.id === bot.id || o.ko || o.skywayUntil > raceTime) continue;
      const rel = sub(o.pos, bot.pos);
      const dist = length(rel);
      if (dist > 9) continue;
      const lat = dot(rel, right);
      if (Math.random() < profile.aggression * 0.03) {
        if (lat > 0) sideRight = true;
        else sideLeft = true;
      }
    }
  }

  // Skyway when meter full and risk-takers say so.
  const skyway = bot.koMeter >= 1 && Math.random() < profile.riskTaking * 0.5;

  return {
    throttle,
    steer,
    boost: wantBoost,
    spin,
    sideLeft,
    sideRight,
    skyway,
  };
};

/**
 * Generate a deterministic display name for a bot from its id.
 * Mixes a small adjective+noun lexicon.
 */
export const botName = (id: string): string => {
  const adj = [
    'Crimson',
    'Azure',
    'Onyx',
    'Solar',
    'Plasma',
    'Neon',
    'Frost',
    'Ember',
    'Echo',
    'Vortex',
    'Quantum',
    'Photon',
  ];
  const noun = [
    'Falcon',
    'Comet',
    'Talon',
    'Striker',
    'Specter',
    'Arrow',
    'Phantom',
    'Bullet',
    'Bolt',
    'Lance',
    'Ghost',
    'Saber',
  ];
  const r = createRng(hashString(id));
  return `${r.pick(adj)} ${r.pick(noun)}`;
};

/**
 * Pick a deterministic color for a bot from its id.
 */
export const botColor = (id: string, palette: readonly string[]): string => {
  const r = createRng(hashString(id) ^ 0xabcdef);
  return r.pick(palette);
};
