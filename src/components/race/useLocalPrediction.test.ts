import { describe, expect, it } from 'vitest';
import {
  _poseFromVehicle,
  _reconcile,
  _vehicleFromSnapshot,
} from './useLocalPrediction.ts';
import {
  FLAG_FINISHED,
  FLAG_FREE_BOOST,
  FLAG_KO,
  FLAG_SKYWAY,
  type ShipSnapshot,
} from '../../../shared/protocol.ts';

const snapshot = (overrides: Partial<ShipSnapshot> = {}): ShipSnapshot => ({
  id: 'me',
  x: 100,
  y: 50,
  h: 0.5,
  vx: 30,
  vy: 0,
  p: 0.8,
  k: 0.2,
  l: 1,
  a: 1234,
  f: 0,
  sc: 0,
  dc: 0,
  ...overrides,
});

describe('vehicleFromSnapshot', () => {
  it('copies kinematics and gameplay state from the snapshot', () => {
    const v = _vehicleFromSnapshot(snapshot(), 'speed', 5);
    expect(v.pos).toEqual({ x: 100, y: 50 });
    expect(v.vel).toEqual({ x: 30, y: 0 });
    expect(v.heading).toBe(0.5);
    expect(v.power).toBe(0.8);
    expect(v.koMeter).toBe(0.2);
    expect(v.lap).toBe(1);
    expect(v.arcLength).toBe(1234);
    expect(v.cls).toBe('speed');
  });

  it('decodes the flag field into ko/finished/skyway/freeBoost', () => {
    const v = _vehicleFromSnapshot(
      snapshot({ f: FLAG_KO | FLAG_SKYWAY }),
      'balanced',
      10,
    );
    expect(v.ko).toBe(true);
    expect(v.skywayUntil).toBeGreaterThan(10); // skyway active → some future ts
    expect(v.finished).toBe(false);
    expect(v.freeBoostUntil).toBe(0);
  });

  it('keeps skyway/freeBoost timers off when the flag is unset', () => {
    const v = _vehicleFromSnapshot(snapshot({ f: 0 }), 'balanced', 10);
    expect(v.skywayUntil).toBe(0);
    expect(v.freeBoostUntil).toBe(0);
  });
});

describe('reconcile', () => {
  const baseV = () => _vehicleFromSnapshot(snapshot(), 'balanced', 0);

  it('hard-snaps when the divergence is huge (e.g. server bounced us off a wall)', () => {
    const v = baseV();
    const s = snapshot({ x: 1000, y: 800 }); // 900-unit gap → > HARD_SNAP_DISTANCE
    const out = _reconcile(v, s, 0);
    expect(out.pos).toEqual({ x: 1000, y: 800 });
  });

  it('accepts the local position when the divergence is below the band', () => {
    const v = baseV();
    const s = snapshot({ x: 100.5, y: 50.2 }); // tiny gap < 1.5
    const out = _reconcile(v, s, 0);
    // Position stays at v's, NOT at s's.
    expect(out.pos.x).toBeCloseTo(100, 5);
    expect(out.pos.y).toBeCloseTo(50, 5);
  });

  it('soft-corrects when the divergence is moderate (not huge, not negligible)', () => {
    const v = baseV();
    const s = snapshot({ x: 110, y: 50 }); // 10-unit gap
    const out = _reconcile(v, s, 0);
    // Lerps ~18 % toward server.
    expect(out.pos.x).toBeCloseTo(101.8, 1);
  });

  it('always refreshes the authoritative gameplay fields from the snapshot', () => {
    const v = baseV();
    const s = snapshot({ x: 100, y: 50, p: 0.4, k: 0.9, a: 9999, l: 3, f: FLAG_FINISHED });
    const out = _reconcile(v, s, 0);
    expect(out.power).toBe(0.4);
    expect(out.koMeter).toBe(0.9);
    expect(out.arcLength).toBe(9999);
    expect(out.lap).toBe(3);
    expect(out.finished).toBe(true);
  });

  it('takes server velocity unconditionally (rather than blending it)', () => {
    const v = baseV(); // vel = (30, 0)
    const s = snapshot({ x: 100, y: 50, vx: 0, vy: 50 });
    const out = _reconcile(v, s, 0);
    expect(out.vel).toEqual({ x: 0, y: 50 });
  });
});

describe('poseFromVehicle', () => {
  it('encodes kinematics and rebuilds the flag bitmask from active timers', () => {
    const v = _vehicleFromSnapshot(snapshot({ f: FLAG_KO | FLAG_FREE_BOOST }), 'balanced', 5);
    const pose = _poseFromVehicle(v, 5);
    expect(pose.x).toBe(100);
    expect(pose.y).toBe(50);
    expect(pose.h).toBe(0.5);
    expect(pose.flags & FLAG_KO).toBeTruthy();
    expect(pose.flags & FLAG_FREE_BOOST).toBeTruthy();
    expect(pose.flags & FLAG_SKYWAY).toBe(0);
    expect(pose.flags & FLAG_FINISHED).toBe(0);
  });

  it('clears skyway/freeBoost flags once the timers expire', () => {
    const v = _vehicleFromSnapshot(snapshot({ f: FLAG_SKYWAY }), 'balanced', 5);
    // Past the 1.0 s window we used as the seed when reconstructing.
    const pose = _poseFromVehicle(v, 7);
    expect(pose.flags & FLAG_SKYWAY).toBe(0);
  });
});
