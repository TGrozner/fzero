import type { Vehicle } from './physics.ts';
import {
  KO_METER_PER_KO,
  SPIN_ATTACK_COOLDOWN_S,
  SPIN_ATTACK_DAMAGE,
  SPIN_ATTACK_RADIUS,
} from './constants.ts';
import { clamp } from './vec2.ts';

/**
 * Apply spin attack from `attacker` against all other vehicles within radius.
 * Returns updated attacker + targets. Pure.
 */
export const applySpinAttack = (
  attacker: Vehicle,
  others: readonly Vehicle[],
  raceTime: number,
): { attacker: Vehicle; others: Vehicle[]; kos: string[] } => {
  if (attacker.spinCd > 0 || attacker.ko) {
    return { attacker, others: [...others], kos: [] };
  }
  const kos: string[] = [];
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
    // Add a small outward impulse to victims.
    const dist = Math.sqrt(distSq) || 1;
    const nx = dx / dist;
    const ny = dy / dist;
    const impulse = 90;
    return {
      ...v,
      power: newPower,
      ko,
      koTime: ko && v.koTime === null ? raceTime : v.koTime,
      vel: { x: v.vel.x + nx * impulse, y: v.vel.y + ny * impulse },
    };
  });
  return { attacker: updatedAttacker, others: updatedOthers, kos };
};
