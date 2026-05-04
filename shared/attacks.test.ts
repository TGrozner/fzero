import { describe, it, expect } from 'vitest';
import { applySideAttack, applySpinAttack } from './attacks.ts';
import { createVehicle } from './physics.ts';
import { v2 } from './vec2.ts';

describe('applySpinAttack', () => {
  it('damages vehicles within radius', () => {
    const attacker = createVehicle('a', v2(0, 0), 0);
    const target = createVehicle('b', v2(5, 0), 0);
    const far = createVehicle('c', v2(50, 0), 0);
    const r = applySpinAttack(attacker, [attacker, target, far], 0);
    const tAfter = r.others.find((v) => v.id === 'b');
    const cAfter = r.others.find((v) => v.id === 'c');
    expect(tAfter?.power).toBeLessThan(target.power);
    expect(cAfter?.power).toBe(far.power);
  });

  it('cooldown prevents back-to-back attacks', () => {
    const attacker = { ...createVehicle('a', v2(0, 0), 0), spinCd: 1 };
    const target = createVehicle('b', v2(5, 0), 0);
    const r = applySpinAttack(attacker, [attacker, target], 0);
    expect(r.others.find((v) => v.id === 'b')?.power).toBe(target.power);
  });

  it('records KO when target HP drops to 0', () => {
    const attacker = createVehicle('a', v2(0, 0), 0);
    const target = { ...createVehicle('b', v2(5, 0), 0), power: 0.05 };
    const r = applySpinAttack(attacker, [attacker, target], 1);
    expect(r.kos).toContain('b');
    const tAfter = r.others.find((v) => v.id === 'b');
    expect(tAfter?.ko).toBe(true);
  });

  it('charges attacker KO meter for each KO', () => {
    const attacker = createVehicle('a', v2(0, 0), 0);
    const t1 = { ...createVehicle('b', v2(5, 0), 0), power: 0.05 };
    const t2 = { ...createVehicle('c', v2(0, 5), 0), power: 0.05 };
    const r = applySpinAttack(attacker, [attacker, t1, t2], 1);
    expect(r.attacker.koMeter).toBeGreaterThan(0);
    expect(r.kos.length).toBe(2);
  });

  it('skips skywayed targets', () => {
    const attacker = createVehicle('a', v2(0, 0), 0);
    const sky = { ...createVehicle('b', v2(5, 0), 0), skywayUntil: 100 };
    const r = applySpinAttack(attacker, [attacker, sky], 0);
    expect(r.others.find((v) => v.id === 'b')?.power).toBe(sky.power);
  });

  it('does nothing when attacker is KO', () => {
    const attacker = { ...createVehicle('a', v2(0, 0), 0), ko: true, power: 0 };
    const target = createVehicle('b', v2(5, 0), 0);
    const r = applySpinAttack(attacker, [attacker, target], 0);
    expect(r.others.find((v) => v.id === 'b')?.power).toBe(target.power);
  });

  it('records hits with victim positions', () => {
    const attacker = createVehicle('a', v2(0, 0), 0);
    const target = createVehicle('b', v2(5, 0), 0);
    const r = applySpinAttack(attacker, [attacker, target], 0);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]?.victimId).toBe('b');
    expect(r.hits[0]?.attackerId).toBe('a');
    expect(r.hits[0]?.kind).toBe('spin');
  });
});

describe('applySideAttack', () => {
  it('damages enemy on the requested side within range', () => {
    // Heading 0 (looking down +x). Right vector is (-sin0, cos0) = (0, 1).
    // So a target at +y is "right" of the attacker.
    const attacker = createVehicle('a', v2(0, 0), 0);
    const right = createVehicle('b', v2(0, 5), 0);
    const left = createVehicle('c', v2(0, -5), 0);
    const r = applySideAttack(attacker, [attacker, right, left], 1, 0);
    expect(r.others.find((v) => v.id === 'b')?.power).toBeLessThan(right.power);
    expect(r.others.find((v) => v.id === 'c')?.power).toBe(left.power);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]?.kind).toBe('side-right');
  });

  it('skips targets outside SIDE_ATTACK_RANGE', () => {
    const attacker = createVehicle('a', v2(0, 0), 0);
    const tooFar = createVehicle('b', v2(0, 30), 0);
    const r = applySideAttack(attacker, [attacker, tooFar], 1, 0);
    expect(r.hits).toHaveLength(0);
  });

  it('left direction targets only ships on the left', () => {
    const attacker = createVehicle('a', v2(0, 0), 0);
    const left = createVehicle('b', v2(0, -5), 0);
    const right = createVehicle('c', v2(0, 5), 0);
    const r = applySideAttack(attacker, [attacker, left, right], -1, 0);
    expect(r.hits.map((h) => h.victimId)).toEqual(['b']);
    expect(r.hits[0]?.kind).toBe('side-left');
  });

  it('records KO + charges attacker KO meter when victim drops to 0', () => {
    const attacker = createVehicle('a', v2(0, 0), 0);
    const weak = { ...createVehicle('b', v2(0, 5), 0), power: 0.05 };
    const r = applySideAttack(attacker, [attacker, weak], 1, 1);
    expect(r.kos).toContain('b');
    expect(r.attacker.koMeter).toBeGreaterThan(0);
  });

  it('skips skywayed targets', () => {
    const attacker = createVehicle('a', v2(0, 0), 0);
    const sky = { ...createVehicle('b', v2(0, 5), 0), skywayUntil: 100 };
    const r = applySideAttack(attacker, [attacker, sky], 1, 0);
    expect(r.hits).toHaveLength(0);
  });
});
