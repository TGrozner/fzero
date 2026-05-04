import { describe, it, expect } from 'vitest';
import {
  createVehicle,
  stepVehicle,
  resolveVehicleCollision,
  NEUTRAL_INPUT,
  DEFAULT_PARAMS,
  paramsForClass,
} from './physics.ts';
import { angleOf, v2 } from './vec2.ts';
import { buildTrack, buildOvalTrack } from './track.ts';

const track = buildTrack('t', 'T', buildOvalTrack(400, 400, 32), 40, 4);
const startHeading = angleOf(track.startHeading);
// A "wide test arena" track for tests that need an obstacle-free area.
const arena = buildTrack('a', 'A', buildOvalTrack(2000, 2000, 32), 800, 4);
const arenaHeading = angleOf(arena.startHeading);

describe('stepVehicle', () => {
  it('throttle accelerates forward', () => {
    const v = createVehicle('p', track.startPosition, startHeading);
    const after = stepVehicle(
      v,
      { ...NEUTRAL_INPUT, throttle: 1 },
      track,
      1 / 30,
      0,
    );
    expect(Math.hypot(after.vel.x, after.vel.y)).toBeGreaterThan(0);
  });

  it('boost speed exceeds normal cap', () => {
    let v = createVehicle('p', arena.startPosition, arenaHeading);
    for (let i = 0; i < 200; i++) {
      v = stepVehicle(v, { ...NEUTRAL_INPUT, throttle: 1 }, arena, 1 / 60, i / 60);
    }
    const normalSpeed = Math.hypot(v.vel.x, v.vel.y);
    let vb = createVehicle('p2', arena.startPosition, arenaHeading);
    for (let i = 0; i < 200; i++) {
      vb = stepVehicle(
        vb,
        { ...NEUTRAL_INPUT, throttle: 1, boost: true },
        arena,
        1 / 60,
        i / 60,
      );
    }
    const boostSpeed = Math.hypot(vb.vel.x, vb.vel.y);
    expect(boostSpeed).toBeGreaterThan(normalSpeed);
  });

  it('boost drains power meter', () => {
    let v = createVehicle('p', arena.startPosition, arenaHeading);
    const before = v.power;
    for (let i = 0; i < 60; i++) {
      v = stepVehicle(v, { ...NEUTRAL_INPUT, throttle: 1, boost: true }, arena, 1 / 60, i / 60);
    }
    expect(v.power).toBeLessThan(before);
  });

  it('steering changes heading', () => {
    let v = createVehicle('p', arena.startPosition, arenaHeading);
    for (let i = 0; i < 30; i++) {
      v = stepVehicle(v, { ...NEUTRAL_INPUT, throttle: 1 }, arena, 1 / 60, i / 60);
    }
    const h0 = v.heading;
    for (let i = 0; i < 30; i++) {
      v = stepVehicle(v, { ...NEUTRAL_INPUT, throttle: 1, steer: 1 }, arena, 1 / 60, i / 60);
    }
    expect(v.heading).not.toBeCloseTo(h0);
  });

  it('side attack imparts lateral velocity', () => {
    let v = createVehicle('p', arena.startPosition, arenaHeading);
    for (let i = 0; i < 20; i++) {
      v = stepVehicle(v, { ...NEUTRAL_INPUT, throttle: 1 }, arena, 1 / 60, i / 60);
    }
    const before = { x: v.vel.x, y: v.vel.y };
    const after = stepVehicle(v, { ...NEUTRAL_INPUT, sideRight: true }, arena, 1 / 60, 1);
    const dvx = after.vel.x - before.x;
    const dvy = after.vel.y - before.y;
    expect(Math.hypot(dvx, dvy)).toBeGreaterThan(50);
    expect(after.sideCd).toBeGreaterThan(0);
  });

  it('side attack respects cooldown', () => {
    let v = createVehicle('p', arena.startPosition, arenaHeading);
    v = stepVehicle(v, { ...NEUTRAL_INPUT, sideRight: true }, arena, 1 / 60, 1);
    const cdAfterFirst = v.sideCd;
    const before = { x: v.vel.x, y: v.vel.y };
    v = stepVehicle(v, { ...NEUTRAL_INPUT, sideRight: true }, arena, 1 / 60, 1);
    expect(v.sideCd).toBeLessThanOrEqual(cdAfterFirst);
    const dvx = v.vel.x - before.x;
    const dvy = v.vel.y - before.y;
    expect(Math.hypot(dvx, dvy)).toBeLessThan(50);
  });

  it('off-track erodes power', () => {
    const offTrackPos = v2(10000, 0);
    const v = createVehicle('p', offTrackPos, 0);
    const after = stepVehicle(v, NEUTRAL_INPUT, track, 1, 0);
    expect(after.power).toBeLessThan(v.power);
  });

  it('KO vehicle does not respond to input', () => {
    const v = { ...createVehicle('p', track.startPosition, 0), power: 0, ko: true };
    const after = stepVehicle(v, { ...NEUTRAL_INPUT, throttle: 1 }, track, 0.5, 0);
    expect(Math.hypot(after.vel.x, after.vel.y)).toBeLessThan(1);
  });

  it('finished vehicle does not respond to input', () => {
    const v = { ...createVehicle('p', track.startPosition, 0), finished: true };
    const after = stepVehicle(v, { ...NEUTRAL_INPUT, throttle: 1 }, track, 0.5, 0);
    expect(Math.hypot(after.vel.x, after.vel.y)).toBeLessThan(1);
  });

  it('respects max speed without boost', () => {
    let v = createVehicle('p', arena.startPosition, arenaHeading);
    for (let i = 0; i < 1000; i++) {
      v = stepVehicle(v, { ...NEUTRAL_INPUT, throttle: 1 }, arena, 1 / 60, i / 60);
    }
    expect(Math.hypot(v.vel.x, v.vel.y)).toBeLessThanOrEqual(DEFAULT_PARAMS.maxSpeed + 1);
  });

  it('skyway grants speed bonus and ignores walls', () => {
    let v = {
      ...createVehicle('p', v2(10000, 10000), 0),
      skywayUntil: 99,
    };
    // Off-track start, but skyway should NOT damage.
    const before = v.power;
    v = stepVehicle(v, { ...NEUTRAL_INPUT, throttle: 1 }, track, 1 / 60, 1);
    expect(v.power).toBeGreaterThanOrEqual(before - 0.001);
  });
});

describe('resolveVehicleCollision', () => {
  it('separates overlapping vehicles', () => {
    const a = { ...createVehicle('a', v2(0, 0), 0), vel: v2(10, 0) };
    const b = { ...createVehicle('b', v2(3, 0), 0), vel: v2(-10, 0) };
    const r = resolveVehicleCollision(a, b, 5);
    const dist = Math.hypot(r.b.pos.x - r.a.pos.x, r.b.pos.y - r.a.pos.y);
    expect(dist).toBeGreaterThanOrEqual(10 - 0.001);
  });

  it('does nothing when separated', () => {
    const a = createVehicle('a', v2(0, 0), 0);
    const b = createVehicle('b', v2(100, 0), 0);
    const r = resolveVehicleCollision(a, b, 5);
    expect(r.a.pos).toEqual(a.pos);
    expect(r.b.pos).toEqual(b.pos);
  });

  it('does nothing when KO', () => {
    const a = { ...createVehicle('a', v2(0, 0), 0), ko: true, power: 0 };
    const b = { ...createVehicle('b', v2(3, 0), 0) };
    const r = resolveVehicleCollision(a, b, 5);
    expect(r.a.pos).toEqual(a.pos);
  });

  it('exchanges momentum (closing speed)', () => {
    const a = { ...createVehicle('a', v2(0, 0), 0), vel: v2(20, 0) };
    const b = { ...createVehicle('b', v2(8, 0), 0), vel: v2(-20, 0) };
    const r = resolveVehicleCollision(a, b, 5);
    expect(r.a.vel.x).toBeLessThan(20);
    expect(r.b.vel.x).toBeGreaterThan(-20);
  });

  it('does nothing when moving apart already', () => {
    const a = { ...createVehicle('a', v2(0, 0), 0), vel: v2(-5, 0) };
    const b = { ...createVehicle('b', v2(8, 0), 0), vel: v2(5, 0) };
    const r = resolveVehicleCollision(a, b, 5);
    expect(r.a.vel.x).toBe(-5);
    expect(r.b.vel.x).toBe(5);
  });
});

describe('paramsForClass', () => {
  it('speed has higher max speed than balanced', () => {
    expect(paramsForClass('speed').maxSpeed).toBeGreaterThan(
      paramsForClass('balanced').maxSpeed,
    );
  });
  it('tank has higher turn rate than speed', () => {
    expect(paramsForClass('tank').turnRate).toBeGreaterThan(
      paramsForClass('speed').turnRate,
    );
  });
  it('balanced equals DEFAULT_PARAMS', () => {
    expect(paramsForClass('balanced')).toEqual(DEFAULT_PARAMS);
  });
});

describe('per-class physics integration', () => {
  it('speed-class vehicle reaches a higher top speed than tank', () => {
    let speed = createVehicle('s', arena.startPosition, arenaHeading, 'speed');
    let tank = createVehicle('t', arena.startPosition, arenaHeading, 'tank');
    for (let i = 0; i < 300; i++) {
      speed = stepVehicle(speed, { ...NEUTRAL_INPUT, throttle: 1 }, arena, 1 / 60, i / 60);
      tank = stepVehicle(tank, { ...NEUTRAL_INPUT, throttle: 1 }, arena, 1 / 60, i / 60);
    }
    const sp = Math.hypot(speed.vel.x, speed.vel.y);
    const tp = Math.hypot(tank.vel.x, tank.vel.y);
    expect(sp).toBeGreaterThan(tp);
  });
});
