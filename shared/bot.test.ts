import { describe, it, expect } from 'vitest';
import {
  type ActivePickup,
  botInput,
  profileFromSeed,
  profileForId,
  botName,
  botColor,
} from './bot.ts';
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

  it('biases steer toward heal pad when low HP', () => {
    // Anchor the bot at the start position with the track-tangent heading
    // so the underlying steering is near zero — any pickup bias becomes
    // observable instead of getting clamped at ±1.
    const heading = Math.atan2(track.startHeading.y, track.startHeading.x);
    const v = {
      ...createVehicle('b', track.startPosition, heading),
      vel: { x: Math.cos(heading) * 50, y: Math.sin(heading) * 50 },
      power: 0.3,
    };
    // Right of heading vector = perp(fwd). Place the heal pad ~10 units
    // ahead and 6 units to the right.
    const fwdX = Math.cos(heading);
    const fwdY = Math.sin(heading);
    const rightX = -Math.sin(heading);
    const rightY = Math.cos(heading);
    const padPos = v2(
      track.startPosition.x + fwdX * 10 + rightX * 6,
      track.startPosition.y + fwdY * 10 + rightY * 6,
    );
    const heal: ActivePickup = { kind: 'heal', pos: padPos };
    const profile = { ...profileFromSeed(99), skill: 1, aggression: 0 };
    const r0 = botInput(v, [], track, profile, 0);
    const rH = botInput(v, [], track, profile, 0, [heal]);
    expect(rH.steer).not.toBe(r0.steer);
    // Heal pad on the right → bot should steer more to the right (positive).
    expect(rH.steer).toBeGreaterThan(r0.steer);
  });

  it('biases steer AWAY from a mine on the path', () => {
    const heading = Math.atan2(track.startHeading.y, track.startHeading.x);
    const v = {
      ...createVehicle('b', track.startPosition, heading),
      vel: { x: Math.cos(heading) * 50, y: Math.sin(heading) * 50 },
      power: 1,
    };
    const fwdX = Math.cos(heading);
    const fwdY = Math.sin(heading);
    const rightX = -Math.sin(heading);
    const rightY = Math.cos(heading);
    const minePos = v2(
      track.startPosition.x + fwdX * 10 + rightX * 6,
      track.startPosition.y + fwdY * 10 + rightY * 6,
    );
    const mine: ActivePickup = { kind: 'mine', pos: minePos };
    const profile = { ...profileFromSeed(7), skill: 1, aggression: 0 };
    const r0 = botInput(v, [], track, profile, 0);
    const rM = botInput(v, [], track, profile, 0, [mine]);
    expect(rM.steer).toBeLessThan(r0.steer);
  });

  it('fires skyway when surrounded by ≥3 close enemies (KO meter full)', () => {
    const v = { ...createVehicle('b', track.startPosition, 0), koMeter: 1 };
    const close = (offset: number, id: string) =>
      createVehicle(id, { x: track.startPosition.x + offset, y: track.startPosition.y }, 0);
    const others = [close(8, 'x'), close(-7, 'y'), close(0, 'z')];
    const profile = { skill: 1, aggression: 0.5, riskTaking: 0 };
    const r = botInput(v, others, track, profile, 0);
    expect(r.skyway).toBe(true);
  });

  it('does NOT fire skyway when threats are far away', () => {
    const v = { ...createVehicle('b', track.startPosition, 0), koMeter: 1 };
    const far = createVehicle('x', { x: track.startPosition.x + 80, y: track.startPosition.y }, 0);
    const profile = { skill: 1, aggression: 0.5, riskTaking: 0 };
    // riskTaking=0 + zero close threats = no skyway despite full meter.
    const r = botInput(v, [far], track, profile, 0);
    expect(r.skyway).toBe(false);
  });

  it('parries with a defensive side attack when an enemy closes from a side', () => {
    // Enemy on bot's right side, closing in fast.
    const v = { ...createVehicle('b', { x: 0, y: 0 }, 0), vel: { x: 50, y: 0 }, sideCd: 0 };
    const enemy = {
      ...createVehicle('e', { x: 1, y: 5 }, 0),
      vel: { x: 50, y: -50 },
    };
    const profile = { skill: 1, aggression: 0.4, riskTaking: 0 };
    const r = botInput(v, [enemy], track, profile, 0);
    // Right of heading=0 is +y, so a closer at +y triggers sideRight.
    expect(r.sideRight).toBe(true);
  });

  it('ignores pickups behind the bot', () => {
    const heading = Math.atan2(track.startHeading.y, track.startHeading.x);
    const v = {
      ...createVehicle('b', track.startPosition, heading),
      vel: { x: Math.cos(heading) * 50, y: Math.sin(heading) * 50 },
      power: 0.3,
    };
    const fwdX = Math.cos(heading);
    const fwdY = Math.sin(heading);
    const rightX = -Math.sin(heading);
    const rightY = Math.cos(heading);
    const behindPos = v2(
      track.startPosition.x - fwdX * 10 + rightX * 5,
      track.startPosition.y - fwdY * 10 + rightY * 5,
    );
    const behind: ActivePickup = { kind: 'heal', pos: behindPos };
    const profile = { ...profileFromSeed(2), skill: 1, aggression: 0 };
    const r0 = botInput(v, [], track, profile, 0);
    const rB = botInput(v, [], track, profile, 0, [behind]);
    expect(rB.steer).toBe(r0.steer);
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
