import { describe, it, expect } from 'vitest';
import {
  v2,
  add,
  sub,
  scale,
  neg,
  dot,
  cross,
  length,
  lengthSq,
  distance,
  distanceSq,
  normalize,
  rotate,
  fromAngle,
  angleOf,
  lerp,
  reflect,
  perp,
  clamp,
  wrapAngle,
  lerpAngle,
  ZERO,
} from './vec2.ts';

describe('vec2', () => {
  it('constructor', () => {
    expect(v2(1, 2)).toEqual({ x: 1, y: 2 });
    expect(ZERO).toEqual({ x: 0, y: 0 });
  });

  it('arithmetic', () => {
    expect(add(v2(1, 2), v2(3, 4))).toEqual({ x: 4, y: 6 });
    expect(sub(v2(5, 5), v2(1, 2))).toEqual({ x: 4, y: 3 });
    expect(scale(v2(2, 3), 2)).toEqual({ x: 4, y: 6 });
    expect(neg(v2(2, -3))).toEqual({ x: -2, y: 3 });
  });

  it('dot/cross', () => {
    expect(dot(v2(1, 0), v2(0, 1))).toBe(0);
    expect(dot(v2(1, 2), v2(3, 4))).toBe(11);
    expect(cross(v2(1, 0), v2(0, 1))).toBe(1);
    expect(cross(v2(0, 1), v2(1, 0))).toBe(-1);
  });

  it('length and distance', () => {
    expect(length(v2(3, 4))).toBe(5);
    expect(lengthSq(v2(3, 4))).toBe(25);
    expect(distance(v2(0, 0), v2(3, 4))).toBe(5);
    expect(distanceSq(v2(0, 0), v2(3, 4))).toBe(25);
  });

  it('normalize', () => {
    expect(normalize(v2(0, 0))).toEqual(ZERO);
    const n = normalize(v2(3, 4));
    expect(n.x).toBeCloseTo(0.6);
    expect(n.y).toBeCloseTo(0.8);
  });

  it('rotate', () => {
    const r = rotate(v2(1, 0), Math.PI / 2);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(1);
  });

  it('fromAngle / angleOf', () => {
    const a = Math.PI / 3;
    const v = fromAngle(a);
    expect(angleOf(v)).toBeCloseTo(a);
    expect(fromAngle(0, 5)).toEqual({ x: 5, y: 0 });
  });

  it('lerp', () => {
    expect(lerp(v2(0, 0), v2(10, 20), 0.5)).toEqual({ x: 5, y: 10 });
    expect(lerp(v2(0, 0), v2(10, 20), 0)).toEqual({ x: 0, y: 0 });
    expect(lerp(v2(0, 0), v2(10, 20), 1)).toEqual({ x: 10, y: 20 });
  });

  it('reflect', () => {
    const r = reflect(v2(1, -1), v2(0, 1));
    expect(r.x).toBeCloseTo(1);
    expect(r.y).toBeCloseTo(1);
  });

  it('perp', () => {
    expect(perp(v2(1, 0))).toEqual({ x: 0, y: 1 });
    expect(perp(v2(0, 1))).toEqual({ x: -1, y: 0 });
  });

  it('clamp', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it('wrapAngle', () => {
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(-Math.PI * 1.5)).toBeCloseTo(Math.PI / 2);
  });

  it('lerpAngle takes the shorter direction', () => {
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4);
    expect(lerpAngle(0.1, -0.1, 0.5)).toBeCloseTo(0);
    // Wraps around: from 3.0 to -3.0 should go through PI, not back through 0.
    const r = lerpAngle(3, -3, 0.5);
    expect(Math.abs(r)).toBeGreaterThan(3);
  });
});
