import {
  type Vec2,
  add,
  sub,
  scale,
  dot,
  length,
  fromAngle,
  clamp,
  perp,
  ZERO,
} from './vec2.ts';
import { closestOnTrack, type Track } from './track.ts';
import {
  BOOST_HP_DRAIN_PER_S,
  BOOST_SPEED_MULT,
  DEFAULT_SHIP_CLASS,
  OFF_TRACK_DAMAGE_PER_S,
  POWER_REGEN_PER_S,
  type ShipClass,
  SKYWAY_SPEED_BONUS,
  WALL_DAMAGE_FACTOR,
} from './constants.ts';

export type Vehicle = {
  readonly id: string;
  /** Ship class — drives PhysicsParams via paramsForClass. */
  readonly cls: ShipClass;
  readonly pos: Vec2;
  readonly vel: Vec2;
  /** Heading in radians (0 = +x). */
  readonly heading: number;
  /** Power meter 0..1: shared HP + boost gauge. */
  readonly power: number;
  /** KO meter 0..1: charges with KOs and checkpoints. */
  readonly koMeter: number;
  /** Cumulative arc length (monotonic; lap*length + projection). */
  readonly arcLength: number;
  readonly lap: number;
  /** Index into track.checkpoints of the next checkpoint to cross. */
  readonly nextCheckpoint: number;
  /** True if vehicle has finished the race. */
  readonly finished: boolean;
  readonly finishTime: number | null;
  /** True if vehicle is KO'd (out of HP). */
  readonly ko: boolean;
  readonly koTime: number | null;
  /** Skyway active until this race time (seconds). 0 = inactive. */
  readonly skywayUntil: number;
  /** Last-N boost active until this race time. 0 = inactive. */
  readonly freeBoostUntil: number;
  /** Cooldown remaining (seconds) for spin attack. */
  readonly spinCd: number;
  /** Cooldown remaining (seconds) for side attack. */
  readonly sideCd: number;
  /** Hint for closestOnTrack: last known segment index. */
  readonly lastSegIdx: number;
};

export type VehicleInput = {
  readonly throttle: number; // -1..+1
  readonly steer: number; // -1..+1
  readonly boost: boolean;
  readonly spin: boolean;
  readonly sideLeft: boolean;
  readonly sideRight: boolean;
  readonly skyway: boolean;
};

export const NEUTRAL_INPUT: VehicleInput = {
  throttle: 0,
  steer: 0,
  boost: false,
  spin: false,
  sideLeft: false,
  sideRight: false,
  skyway: false,
};

export type PhysicsParams = {
  readonly accel: number;
  readonly brake: number;
  readonly drag: number;
  readonly offTrackDrag: number;
  readonly lateralGrip: number;
  readonly turnRate: number;
  readonly maxSpeed: number;
  readonly wallRestitution: number;
};

export const DEFAULT_PARAMS: PhysicsParams = {
  accel: 220,
  brake: 300,
  drag: 0.4,
  offTrackDrag: 1.8,
  lateralGrip: 6,
  turnRate: 2.6,
  maxSpeed: 280,
  wallRestitution: 0.4,
};

const SPEED_PARAMS: PhysicsParams = {
  ...DEFAULT_PARAMS,
  accel: 240,
  maxSpeed: 320,
  turnRate: 2.2,
  lateralGrip: 5,
};

const TANK_PARAMS: PhysicsParams = {
  ...DEFAULT_PARAMS,
  accel: 200,
  brake: 320,
  maxSpeed: 250,
  turnRate: 3.1,
  lateralGrip: 7,
  wallRestitution: 0.55,
};

/** Class → physics profile lookup. Pure. */
export const paramsForClass = (cls: ShipClass): PhysicsParams => {
  switch (cls) {
    case 'speed':
      return SPEED_PARAMS;
    case 'tank':
      return TANK_PARAMS;
    case 'balanced':
    default:
      return DEFAULT_PARAMS;
  }
};

export const createVehicle = (
  id: string,
  pos: Vec2,
  heading: number,
  cls: ShipClass = DEFAULT_SHIP_CLASS,
): Vehicle => ({
  id,
  cls,
  pos,
  vel: ZERO,
  heading,
  power: 1,
  koMeter: 0,
  arcLength: 0,
  lap: 0,
  nextCheckpoint: 1,
  finished: false,
  finishTime: null,
  ko: false,
  koTime: null,
  skywayUntil: 0,
  freeBoostUntil: 0,
  spinCd: 0,
  sideCd: 0,
  lastSegIdx: 0,
});

const decelerate = (v: Vehicle, dt: number, params: PhysicsParams): Vehicle => {
  const vel = scale(v.vel, Math.max(0, 1 - params.drag * dt * 2));
  const pos = add(v.pos, scale(vel, dt));
  return { ...v, vel, pos };
};

/**
 * Pure step: apply input + physics for `dt` seconds.
 * `params` defaults to the per-class profile so the caller doesn't need to
 * know about classes; pass an explicit profile only for tests / overrides.
 */
export const stepVehicle = (
  v: Vehicle,
  input: VehicleInput,
  track: Track,
  dt: number,
  raceTime: number,
  params: PhysicsParams = paramsForClass(v.cls),
): Vehicle => {
  if (v.ko || v.finished) {
    return decelerate(v, dt, params);
  }

  const skywayActive = v.skywayUntil > raceTime;
  const freeBoostActive = v.freeBoostUntil > raceTime;
  const wantsBoost = (input.boost && v.power > 0) || freeBoostActive;
  const speedMult = skywayActive
    ? SKYWAY_SPEED_BONUS
    : wantsBoost
      ? BOOST_SPEED_MULT
      : 1;

  const steer = clamp(input.steer, -1, 1);
  const throttle = clamp(input.throttle, -1, 1);

  // Speed-relative steering authority.
  const speed = length(v.vel);
  const steerAuth = clamp(speed / 60, 0.15, 1);
  const newHeading = v.heading + steer * params.turnRate * steerAuth * dt;

  const fwd = fromAngle(newHeading);
  const right = perp(fwd);

  const accel = throttle >= 0 ? params.accel : params.brake;
  const accelMul = wantsBoost ? 1.4 : 1;
  const thrust = scale(fwd, throttle * accel * accelMul);

  let vel = add(v.vel, scale(thrust, dt));

  // Lateral grip: kill sideways velocity component.
  const lateralVel = dot(vel, right);
  const gripFactor = clamp(params.lateralGrip * dt, 0, 1);
  vel = sub(vel, scale(right, lateralVel * gripFactor));

  // Drag (off-track much higher).
  const onTrackInfo = closestOnTrack(track, v.pos, v.lastSegIdx);
  const onTrack = onTrackInfo.distance <= track.halfWidth;
  const dragK = onTrack || skywayActive ? params.drag : params.drag * params.offTrackDrag;
  vel = scale(vel, Math.max(0, 1 - dragK * dt));

  // Side attack impulses (lateral burst). Cooldown handled below.
  const sideAttackTriggered =
    (input.sideLeft || input.sideRight) && v.sideCd <= 0;
  if (sideAttackTriggered) {
    if (input.sideLeft) vel = sub(vel, scale(right, 280));
    if (input.sideRight) vel = add(vel, scale(right, 280));
  }

  // Cap speed.
  const maxSpd = params.maxSpeed * speedMult;
  const sp = length(vel);
  if (sp > maxSpd) vel = scale(vel, maxSpd / sp);

  // Integrate position.
  let pos = add(v.pos, scale(vel, dt));

  // Wall collision (skyway is immune).
  let wallDamage = 0;
  if (!skywayActive) {
    const after = closestOnTrack(track, pos, onTrackInfo.segIdx);
    if (after.distance > track.halfWidth) {
      const overshoot = after.distance - track.halfWidth;
      const dx = after.projected.x - pos.x;
      const dy = after.projected.y - pos.y;
      const nLen = Math.hypot(dx, dy) || 1;
      const nx = dx / nLen;
      const ny = dy / nLen;
      pos = { x: pos.x + nx * overshoot, y: pos.y + ny * overshoot };
      const vn = vel.x * nx + vel.y * ny;
      if (vn < 0) {
        wallDamage = -vn * WALL_DAMAGE_FACTOR;
        vel = {
          x: vel.x - (1 + params.wallRestitution) * vn * nx,
          y: vel.y - (1 + params.wallRestitution) * vn * ny,
        };
      }
    }
  }

  // Power meter changes.
  let power = v.power;
  if (wantsBoost && !freeBoostActive) {
    power -= BOOST_HP_DRAIN_PER_S * dt;
  }
  if (!onTrack && !skywayActive) {
    power -= OFF_TRACK_DAMAGE_PER_S * dt;
  }
  power -= wallDamage;
  // Passive regen: clean driving (on-track, no boost, not skywaying, not
  // already KO'd) slowly refills HP. Lets players recover from a bump or
  // corner clip instead of attriting toward inevitable death.
  if (onTrack && !wantsBoost && !skywayActive && power > 0) {
    power += POWER_REGEN_PER_S * dt;
  }
  power = clamp(power, 0, 1);

  const ko = power <= 0;
  const spinCd = Math.max(0, v.spinCd - dt);
  const sideCd = sideAttackTriggered ? 1.0 : Math.max(0, v.sideCd - dt);

  return {
    ...v,
    pos,
    vel,
    heading: newHeading,
    power,
    ko,
    koTime: ko && v.koTime === null ? raceTime : v.koTime,
    spinCd,
    sideCd,
    lastSegIdx: onTrackInfo.segIdx,
  };
};

/** Resolve elastic-ish collision between two equal-mass vehicles. */
export const resolveVehicleCollision = (
  a: Vehicle,
  b: Vehicle,
  radius: number,
  restitution = 0.5,
): { a: Vehicle; b: Vehicle } => {
  if (a.ko || b.ko) return { a, b };
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const dist = Math.hypot(dx, dy);
  if (dist === 0 || dist >= radius * 2) return { a, b };
  const overlap = radius * 2 - dist;
  const nx = dx / dist;
  const ny = dy / dist;
  const aPos: Vec2 = { x: a.pos.x - nx * overlap * 0.5, y: a.pos.y - ny * overlap * 0.5 };
  const bPos: Vec2 = { x: b.pos.x + nx * overlap * 0.5, y: b.pos.y + ny * overlap * 0.5 };
  const rvx = b.vel.x - a.vel.x;
  const rvy = b.vel.y - a.vel.y;
  const velAlongNormal = rvx * nx + rvy * ny;
  if (velAlongNormal > 0) {
    return { a: { ...a, pos: aPos }, b: { ...b, pos: bPos } };
  }
  const j = -(1 + restitution) * velAlongNormal * 0.5;
  const aVel: Vec2 = { x: a.vel.x - j * nx, y: a.vel.y - j * ny };
  const bVel: Vec2 = { x: b.vel.x + j * nx, y: b.vel.y + j * ny };
  // Damage proportional to closing speed.
  const impact = Math.abs(velAlongNormal) * 0.0008;
  return {
    a: { ...a, pos: aPos, vel: aVel, power: clamp(a.power - impact, 0, 1) },
    b: { ...b, pos: bPos, vel: bVel, power: clamp(b.power - impact, 0, 1) },
  };
};
