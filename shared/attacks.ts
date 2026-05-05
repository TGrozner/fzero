import type { Vehicle } from './physics.ts';
import {
  KO_METER_PER_KO,
  SIDE_ATTACK_COOLDOWN_S,
  SIDE_ATTACK_DAMAGE,
  SIDE_ATTACK_KNOCKBACK,
  SIDE_ATTACK_RANGE,
  SPIN_ATTACK_COOLDOWN_S,
  SPIN_ATTACK_DAMAGE,
  SPIN_ATTACK_IMPULSE,
  SPIN_ATTACK_RADIUS,
} from './constants.ts';
import { clamp } from './vec2.ts';

/** A landed hit, used to drive client-side FX. */
export type AttackHit = {
  readonly victimId: string;
  readonly attackerId: string;
  /** World position of the victim at the moment of the hit. */
  readonly x: number;
  readonly y: number;
  readonly kind: 'spin' | 'side-left' | 'side-right';
};

/**
 * Apply spin attack from `attacker` against all other vehicles within radius.
 * Returns updated attacker + targets. Pure.
 */
export const applySpinAttack = (
  attacker: Vehicle,
  others: readonly Vehicle[],
  raceTime: number,
): { attacker: Vehicle; others: Vehicle[]; kos: string[]; hits: AttackHit[] } => {
  if (attacker.spinCd > 0 || attacker.ko) {
    return { attacker, others: [...others], kos: [], hits: [] };
  }
  const kos: string[] = [];
  const hits: AttackHit[] = [];
  let updatedAttacker = { ...attacker, spinCd: SPIN_ATTACK_COOLDOWN_S };
  const updatedOthers = others.map((v) => {
    if (v.id === attacker.id || v.ko || v.skywayUntil > raceTime) return v;
    const dx = v.pos.x - attacker.pos.x;
    const dy = v.pos.y - attacker.pos.y;
    const distSq = dx * dx + dy * dy;
    if (distSq > SPIN_ATTACK_RADIUS * SPIN_ATTACK_RADIUS) return v;
    const newPower = clamp(v.power - SPIN_ATTACK_DAMAGE, 0, 1);
    const ko = newPower <= 0;
    if (ko && !v.ko) {
      kos.push(v.id);
      updatedAttacker = {
        ...updatedAttacker,
        koMeter: clamp(updatedAttacker.koMeter + KO_METER_PER_KO, 0, 1),
      };
    }
    hits.push({
      victimId: v.id,
      attackerId: attacker.id,
      x: v.pos.x,
      y: v.pos.y,
      kind: 'spin',
    });
    // Add a small outward impulse to victims.
    const dist = Math.sqrt(distSq) || 1;
    const nx = dx / dist;
    const ny = dy / dist;
    const impulse = SPIN_ATTACK_IMPULSE;
    return {
      ...v,
      power: newPower,
      ko,
      koTime: ko && v.koTime === null ? raceTime : v.koTime,
      vel: { x: v.vel.x + nx * impulse, y: v.vel.y + ny * impulse },
    };
  });
  return { attacker: updatedAttacker, others: updatedOthers, kos, hits };
};

/**
 * Side-attack: damage + lateral knockback to enemies on the chosen side
 * (relative to the attacker's heading) within SIDE_ATTACK_RANGE.
 *
 * Pre-existing physics also applies a self-impulse to the attacker; this
 * function only handles the *outgoing* damage / knockback to victims.
 *
 * `dir` = -1 → left side, +1 → right side.
 */
export const applySideAttack = (
  attacker: Vehicle,
  others: readonly Vehicle[],
  dir: -1 | 1,
  raceTime: number,
): { attacker: Vehicle; others: Vehicle[]; kos: string[]; hits: AttackHit[] } => {
  // Mirror the spin path: gate on cooldown so a held Q/E key doesn't keep
  // re-arming the cooldown every tick.
  if (attacker.ko || attacker.sideCd > 0) {
    return { attacker, others: [...others], kos: [], hits: [] };
  }
  const cosH = Math.cos(attacker.heading);
  const sinH = Math.sin(attacker.heading);
  const rx = -sinH;
  const ry = cosH;
  const r2 = SIDE_ATTACK_RANGE * SIDE_ATTACK_RANGE;
  let updatedAttacker = { ...attacker, sideCd: SIDE_ATTACK_COOLDOWN_S };
  const kos: string[] = [];
  const hits: AttackHit[] = [];
  const updatedOthers = others.map((v) => {
    if (v.id === attacker.id || v.ko || v.skywayUntil > raceTime) return v;
    const dx = v.pos.x - attacker.pos.x;
    const dy = v.pos.y - attacker.pos.y;
    const distSq = dx * dx + dy * dy;
    if (distSq > r2) return v;
    // Side filter: lateral component along ±right vector must be on the
    // requested side.
    const lat = dx * rx + dy * ry; // +ve = right of heading
    if (dir === 1 ? lat <= 0 : lat >= 0) return v;
    const newPower = clamp(v.power - SIDE_ATTACK_DAMAGE, 0, 1);
    const ko = newPower <= 0;
    if (ko && !v.ko) {
      kos.push(v.id);
      updatedAttacker = {
        ...updatedAttacker,
        koMeter: clamp(updatedAttacker.koMeter + KO_METER_PER_KO, 0, 1),
      };
    }
    hits.push({
      victimId: v.id,
      attackerId: attacker.id,
      x: v.pos.x,
      y: v.pos.y,
      kind: dir === -1 ? 'side-left' : 'side-right',
    });
    // Lateral knockback away in the attack direction.
    const impulse = SIDE_ATTACK_KNOCKBACK;
    return {
      ...v,
      power: newPower,
      ko,
      koTime: ko && v.koTime === null ? raceTime : v.koTime,
      vel: { x: v.vel.x + rx * dir * impulse, y: v.vel.y + ry * dir * impulse },
    };
  });
  return { attacker: updatedAttacker, others: updatedOthers, kos, hits };
};
