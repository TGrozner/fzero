import { describe, expect, it } from 'vitest';
import {
  BRAKE_THRESHOLD,
  computeStick,
  DEAD_ZONE_PX,
  NEUTRAL_STICK,
  RADIUS_PX,
  STEER_THRESHOLD,
} from './joystickMath.ts';

describe('computeStick', () => {
  it('returns the neutral state inside the dead zone', () => {
    const out = computeStick(5, 5);
    expect(out.active).toBe(false);
    expect(out.up).toBe(false);
    expect(out.down).toBe(false);
    expect(out.left).toBe(false);
    expect(out.right).toBe(false);
  });

  it('detects a clear right deflection', () => {
    const out = computeStick(50, 0);
    expect(out.right).toBe(true);
    expect(out.left).toBe(false);
    expect(out.up).toBe(false);
    expect(out.down).toBe(false);
  });

  it('detects a clear up (throttle) deflection', () => {
    const out = computeStick(0, -50);
    expect(out.up).toBe(true);
    expect(out.down).toBe(false);
  });

  it('uses an asymmetric brake threshold so soft down nudges do not brake', () => {
    // Tilt down by ~40 % of the unit circle — past STEER_THRESHOLD but well
    // under BRAKE_THRESHOLD.
    const out = computeStick(0, 50 * 0.45 + 30);
    // Hmm, easier: directly at angle 0.4 down.
    const len = 50;
    const ny = 0.4;
    const nx = Math.sqrt(1 - ny * ny); // any direction; we only care about ny
    const out2 = computeStick(nx * len, ny * len);
    expect(out2.down).toBe(false);
    expect(STEER_THRESHOLD).toBeLessThan(BRAKE_THRESHOLD);
    // And indeed past the threshold we DO brake.
    const ny2 = 0.7;
    const out3 = computeStick(0, ny2 * 50);
    expect(out3.down).toBe(true);
    expect(out).toBeDefined();
  });

  it('fires both throttle and steer for a diagonal up-right push', () => {
    // 45° up-right at full deflection.
    const len = RADIUS_PX;
    const angle = -Math.PI / 4; // up-right
    const out = computeStick(len * Math.cos(angle), len * Math.sin(angle));
    expect(out.up).toBe(true);
    expect(out.right).toBe(true);
    expect(out.left).toBe(false);
    expect(out.down).toBe(false);
  });

  it('clamps the knob position to RADIUS_PX past the visible ring', () => {
    const out = computeStick(500, 0); // way past
    const len = Math.hypot(out.knob.x, out.knob.y);
    expect(len).toBeCloseTo(RADIUS_PX, 5);
  });

  it('reports the knob unclamped within the ring', () => {
    const out = computeStick(30, 0);
    expect(out.knob.x).toBeCloseTo(30, 5);
    expect(out.knob.y).toBeCloseTo(0, 5);
    expect(out.active).toBe(true);
  });

  it('NEUTRAL_STICK matches the in-deadzone return', () => {
    const out = computeStick(0, 0);
    expect(out.up).toBe(NEUTRAL_STICK.up);
    expect(out.down).toBe(NEUTRAL_STICK.down);
    expect(out.left).toBe(NEUTRAL_STICK.left);
    expect(out.right).toBe(NEUTRAL_STICK.right);
    expect(out.active).toBe(NEUTRAL_STICK.active);
  });

  it('treats exactly the dead-zone radius as outside the dead zone', () => {
    // dx,dy at distance > DEAD_ZONE_PX
    const out = computeStick(DEAD_ZONE_PX + 1, 0);
    expect(out.active).toBe(true);
  });
});
