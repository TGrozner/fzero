import {
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

  // Avoid the nearest other vehicle directly in front.
  const fwd = fromAngle(bot.heading);
  let avoidSteer = 0;
  for (const o of others) {
    if (o.id === bot.id || o.ko) continue;
    const rel = sub(o.pos, bot.pos);
    const dist = length(rel);
    if (dist > 25) continue;
    const forwardDot = dot(rel, fwd);
    if (forwardDot <= 0) continue; // behind us
    // Compute side of obstacle: positive = on left, negative = on right.
    const right = perp(fwd);
    const lateralDot = dot(rel, right);
    avoidSteer += -Math.sign(lateralDot) * (1 - dist / 25) * 0.6;
  }
  steer = clamp(steer + avoidSteer, -1, 1);

  // Boost when conditions are favorable: heading aligned + plenty of power.
  const aligned = Math.abs(angleDiff) < 0.25;
  const wantBoost = aligned && bot.power > 0.55 && profile.skill > 0.4;

  // Spin attack when there is an enemy very close in front.
  let spin = false;
  for (const o of others) {
    if (o.id === bot.id || o.ko || o.skywayUntil > raceTime) continue;
    const rel = sub(o.pos, bot.pos);
    const dist = length(rel);
    if (dist > 12) continue;
    const forwardDot = dot(rel, fwd);
    if (forwardDot < 0) continue;
    if (Math.random() < profile.aggression && bot.spinCd <= 0) {
      spin = true;
      break;
    }
  }

  // Side attack if a target is right beside us.
  let sideLeft = false;
  let sideRight = false;
  if (bot.sideCd <= 0 && profile.aggression > 0.4) {
    const right = perp(fwd);
    for (const o of others) {
      if (o.id === bot.id || o.ko || o.skywayUntil > raceTime) continue;
      const rel = sub(o.pos, bot.pos);
      const dist = length(rel);
      if (dist > 9) continue;
      const lat = dot(rel, right);
      if (Math.random() < profile.aggression * 0.6) {
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
