import { describe, it, expect } from 'vitest';
import { botInput, profileFromSeed, profileForId, botName, botColor } from './bot.ts';
import { createVehicle } from './physics.ts';
import { buildOvalTrack, buildTrack } from './track.ts';
import { v2 } from './vec2.ts';
import { SHIP_COLORS } from './constants.ts';

const track = buildTrack('t', 'T', buildOvalTrack(400, 400, 32), 40, 4);

describe('profileFromSeed', () => {
  it('is deterministic', () => {
    expect(profileFromSeed(1)).toEqual(profileFromSeed(1));
  });
  it('produces different profiles for different seeds', () => {
    expect(profileFromSeed(1)).not.toEqual(profileFromSeed(2));
  });
  it('skill is in [0.4, 1]', () => {
    for (let i = 0; i < 100; i++) {
      const p = profileFromSeed(i);
      expect(p.skill).toBeGreaterThanOrEqual(0.4);
      expect(p.skill).toBeLessThanOrEqual(1);
    }
  });
});

describe('profileForId', () => {
  it('is deterministic for the same id', () => {
    expect(profileForId('bot-7')).toEqual(profileForId('bot-7'));
  });
});

describe('botInput', () => {
  it('returns NEUTRAL_INPUT for KO bot', () => {
    const v = { ...createVehicle('b', track.startPosition, 0), ko: true };
    const r = botInput(v, [], track, profileFromSeed(1), 0);
    expect(r.throttle).toBe(0);
    expect(r.steer).toBe(0);
  });

  it('throttles forward when on track', () => {
    const v = createVehicle('b', track.startPosition, 0);
    const r = botInput(v, [], track, profileFromSeed(1), 0);
    expect(r.throttle).toBeGreaterThan(0);
  });

  it('steer is in [-1, 1]', () => {
    const v = createVehicle('b', track.startPosition, 0);
    for (let i = 0; i < 5; i++) {
      const r = botInput(v, [], track, profileFromSeed(i), i);
      expect(r.steer).toBeGreaterThanOrEqual(-1);
      expect(r.steer).toBeLessThanOrEqual(1);
    }
  });

  it('attempts to avoid a vehicle directly in front', () => {
    const v = { ...createVehicle('a', v2(0, 0), 0), vel: { x: 50, y: 0 } };
    const obstacle = { ...createVehicle('b', v2(15, 1), 0) };
    const empty = botInput(v, [v], track, profileFromSeed(1), 0);
    const blocked = botInput(v, [v, obstacle], track, profileFromSeed(1), 0);
    // Avoidance should at least change steer.
    expect(blocked.steer).not.toBe(empty.steer);
  });

  it('proposes skyway only when meter is full', () => {
    const v = { ...createVehicle('b', track.startPosition, 0), koMeter: 0.5 };
    const r = botInput(v, [], track, profileFromSeed(0), 0);
    expect(r.skyway).toBe(false);
  });
});

describe('botName / botColor', () => {
  it('botName is deterministic', () => {
    expect(botName('foo')).toBe(botName('foo'));
  });
  it('botColor returns a value from the palette', () => {
    expect(SHIP_COLORS).toContain(botColor('xyz', SHIP_COLORS));
  });
  it('different ids tend to produce different names', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(botName(`bot-${i}`));
    expect(seen.size).toBeGreaterThan(20);
  });
});
