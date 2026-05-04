import { describe, it, expect } from 'vitest';
import {
  buildRaceConfig,
  isRaceOver,
  maybeTriggerLastNBoost,
  standings,
  stepRace,
  tryActivateSkyway,
  updateLapProgress,
} from './race.ts';
import { createVehicle, NEUTRAL_INPUT, type VehicleInput } from './physics.ts';
import { buildOvalTrack, buildTrack } from './track.ts';
import { v2 } from './vec2.ts';

const track = buildTrack('t', 'T', buildOvalTrack(400, 400, 32), 40, 4);
const config = buildRaceConfig(track, 3);

describe('updateLapProgress', () => {
  it('arc length only grows monotonically', () => {
    const v = createVehicle('p', track.startPosition, 0);
    const updated = updateLapProgress(v, config, 0);
    expect(updated.arcLength).toBeGreaterThanOrEqual(0);
  });

  it('crossing checkpoints charges KO meter', () => {
    let v = createVehicle('p', track.startPosition, 0);
    // Force arc length forward past a checkpoint and re-update.
    const cpIdx = track.checkpoints[1] as number;
    const cpArc = (track.cumulative[cpIdx] as number) + 1;
    v = { ...v, arcLength: cpArc, pos: track.centerline[cpIdx] as { x: number; y: number } };
    const after = updateLapProgress(v, config, 0);
    expect(after.koMeter).toBeGreaterThan(0);
    expect(after.nextCheckpoint).toBe(2);
  });

  it('completing all checkpoints in a lap increments lap counter', () => {
    let v = createVehicle('p', track.startPosition, 0);
    // Advance fully one lap of arc.
    v = { ...v, arcLength: track.length + 1, pos: track.centerline[1] as { x: number; y: number } };
    v = updateLapProgress(v, config, 0);
    expect(v.lap).toBeGreaterThanOrEqual(1);
  });

  it('finishing the race sets finished + finishTime', () => {
    let v = createVehicle('p', track.startPosition, 0);
    v = { ...v, lap: 2, arcLength: track.length * 3 + 5 };
    v = updateLapProgress(v, config, 12.34);
    expect(v.finished).toBe(true);
    expect(v.finishTime).toBe(12.34);
  });

  it('does NOT spuriously advance lap when spawned behind start on a closed track', () => {
    // Place a vehicle physically behind the start line. closestOnTrack will
    // return a near-trackLen arc value because the centerline wraps; the lap
    // counter must recognise this as "pre-start" and not count it as having
    // completed a lap.
    const startCpIdx = track.checkpoints[0] as number;
    const segA = track.centerline[startCpIdx] as { x: number; y: number };
    const segB = track.centerline[(startCpIdx + 1) % track.centerline.length] as { x: number; y: number };
    const tx = segB.x - segA.x;
    const ty = segB.y - segA.y;
    const len = Math.hypot(tx, ty) || 1;
    // Move ~30 units backward along the start tangent.
    const behind = { x: segA.x - (tx / len) * 30, y: segA.y - (ty / len) * 30 };
    const v = createVehicle('p', behind, 0);
    const after = updateLapProgress(v, config, 0);
    expect(after.lap).toBe(0);
    expect(after.finished).toBe(false);
    expect(after.arcLength).toBeLessThanOrEqual(0);
  });

  it('does nothing if vehicle finished or KO', () => {
    const fin = { ...createVehicle('p', track.startPosition, 0), finished: true };
    const ko = { ...createVehicle('p', track.startPosition, 0), ko: true };
    expect(updateLapProgress(fin, config, 0)).toEqual(fin);
    expect(updateLapProgress(ko, config, 0)).toEqual(ko);
  });
});

describe('tryActivateSkyway', () => {
  it('activates only when KO meter is full', () => {
    const v = { ...createVehicle('p', track.startPosition, 0), koMeter: 1 };
    const r = tryActivateSkyway(v, 5);
    expect(r.skywayUntil).toBeGreaterThan(5);
    expect(r.koMeter).toBe(0);
  });

  it('no-ops when KO meter not full', () => {
    const v = { ...createVehicle('p', track.startPosition, 0), koMeter: 0.5 };
    const r = tryActivateSkyway(v, 5);
    expect(r.skywayUntil).toBe(0);
  });

  it('no-ops while skyway already active', () => {
    const v = { ...createVehicle('p', track.startPosition, 0), koMeter: 1, skywayUntil: 99 };
    const r = tryActivateSkyway(v, 5);
    expect(r.koMeter).toBe(1);
  });

  it('no-ops on KO/finished', () => {
    const v = { ...createVehicle('p', track.startPosition, 0), koMeter: 1, ko: true };
    expect(tryActivateSkyway(v, 5).skywayUntil).toBe(0);
  });
});

describe('maybeTriggerLastNBoost', () => {
  const mkAlive = (id: string) => createVehicle(id, track.startPosition, 0);
  const mkKO = (id: string) => ({ ...createVehicle(id, track.startPosition, 0), ko: true, power: 0 });

  it('does not trigger when more than threshold alive', () => {
    const vehicles = Array.from({ length: 30 }, (_, i) => mkAlive(`p${i}`));
    const r = maybeTriggerLastNBoost(vehicles, 0, false);
    expect(r.triggered).toBe(false);
  });

  it('triggers when alive count drops to threshold', () => {
    const alive = Array.from({ length: 15 }, (_, i) => mkAlive(`a${i}`));
    const ko = Array.from({ length: 5 }, (_, i) => mkKO(`k${i}`));
    const r = maybeTriggerLastNBoost([...alive, ...ko], 5, false);
    expect(r.triggered).toBe(true);
    expect(r.vehicles.find((v) => v.id === 'a0')?.freeBoostUntil).toBeGreaterThan(5);
  });

  it('does not retrigger if already triggered', () => {
    const alive = Array.from({ length: 5 }, (_, i) => mkAlive(`a${i}`));
    const r = maybeTriggerLastNBoost(alive, 5, true);
    expect(r.triggered).toBe(true);
    expect(r.vehicles.find((v) => v.id === 'a0')?.freeBoostUntil).toBe(0);
  });
});

describe('stepRace', () => {
  it('advances physics for all vehicles', () => {
    const a = createVehicle('a', track.startPosition, 0);
    const b = createVehicle('b', { x: track.startPosition.x + 30, y: track.startPosition.y }, 0);
    const inputs = new Map<string, VehicleInput>([
      ['a', { ...NEUTRAL_INPUT, throttle: 1 }],
      ['b', { ...NEUTRAL_INPUT, throttle: 1 }],
    ]);
    const r = stepRace([a, b], inputs, config, 1 / 30, 0);
    expect(r.vehicles[0]?.vel.x).toBeGreaterThan(0);
    expect(r.vehicles[1]?.vel.x).toBeGreaterThan(0);
  });

  it('processes spin attacks and reports KOs', () => {
    const start = track.startPosition;
    const attacker = createVehicle('a', start, 0);
    const victim = {
      ...createVehicle('b', { x: start.x + 4, y: start.y + 2 }, 0),
      power: 0.05,
    };
    const inputs = new Map<string, VehicleInput>([
      ['a', { ...NEUTRAL_INPUT, spin: true }],
    ]);
    const r = stepRace([attacker, victim], inputs, config, 1 / 30, 5);
    expect(r.kos.map((k) => k.id)).toContain('b');
    expect(r.kos.find((k) => k.id === 'b')?.by).toBe('a');
  });

  it('applies skyway when input requested and KO meter full', () => {
    const v = { ...createVehicle('a', track.startPosition, 0), koMeter: 1 };
    const inputs = new Map<string, VehicleInput>([
      ['a', { ...NEUTRAL_INPUT, skyway: true }],
    ]);
    const r = stepRace([v], inputs, config, 1 / 30, 2);
    expect(r.vehicles[0]?.skywayUntil).toBeGreaterThan(2);
  });

  it('uses neutral input for missing entries', () => {
    const v = createVehicle('a', track.startPosition, 0);
    const r = stepRace([v], new Map(), config, 1 / 30, 0);
    expect(r.vehicles[0]?.vel.x).toBeCloseTo(0);
  });

  it('grants spawn protection: no damage and no spin attacks for first 2.5s', () => {
    const start = track.startPosition;
    const attacker = createVehicle('a', start, 0);
    const victim = {
      ...createVehicle('b', { x: start.x + 4, y: start.y + 2 }, 0),
      power: 0.05,
    };
    const inputs = new Map<string, VehicleInput>([
      ['a', { ...NEUTRAL_INPUT, spin: true }],
    ]);
    const r = stepRace([attacker, victim], inputs, config, 1 / 30, 0.5);
    expect(r.kos).toEqual([]);
    expect(r.vehicles.find((v) => v.id === 'b')?.power).toBe(1);
  });

  it('off-track vehicles take no damage during spawn protection', () => {
    const v = { ...createVehicle('p', v2(10000, 10000), 0), power: 0.1 };
    const r = stepRace([v], new Map(), config, 1 / 30, 0.5);
    expect(r.vehicles[0]?.power).toBe(1);
    expect(r.vehicles[0]?.ko).toBe(false);
  });
});

describe('standings', () => {
  it('sorts finished by finishTime, then by arcLength', () => {
    const f1 = { ...createVehicle('f1', v2(0, 0), 0), finished: true, finishTime: 10 };
    const f2 = { ...createVehicle('f2', v2(0, 0), 0), finished: true, finishTime: 5 };
    const live = { ...createVehicle('l', v2(0, 0), 0), arcLength: 100 };
    const ko = { ...createVehicle('k', v2(0, 0), 0), ko: true, power: 0 };
    const s = standings([live, ko, f1, f2]);
    expect(s[0]?.id).toBe('f2');
    expect(s[1]?.id).toBe('f1');
    expect(s[2]?.id).toBe('l');
    expect(s[3]?.id).toBe('k');
  });
});

describe('isRaceOver', () => {
  it('false on empty', () => {
    expect(isRaceOver([], 3)).toBe(false);
  });

  it('true when all finished or KO', () => {
    const v = [
      { ...createVehicle('a', v2(0, 0), 0), finished: true },
      { ...createVehicle('b', v2(0, 0), 0), ko: true, power: 0 },
    ];
    expect(isRaceOver(v, 3)).toBe(true);
  });

  it('false while at least one alive racer remains and others finished', () => {
    const v = [
      { ...createVehicle('a', v2(0, 0), 0), finished: true },
      createVehicle('b', v2(0, 0), 0),
    ];
    expect(isRaceOver(v, 3)).toBe(false);
  });
});
