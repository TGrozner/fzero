import { describe, it, expect } from 'vitest';
import { RoomCore } from './roomCore.ts';
import { encodeInput } from './protocol.ts';
import { decodeInput } from './protocol.ts';
import { MAX_RACERS } from './constants.ts';

describe('RoomCore lifecycle', () => {
  it('adds a human and emits a welcome', () => {
    const r = new RoomCore();
    const { id, welcome } = r.addHuman('c1', 'Tom', '#3aa0ff');
    expect(id).toMatch(/^p\d+$/);
    expect(welcome.type).toBe('welcome');
    expect(r.players.size).toBe(1);
  });

  it('startsIn is set when the first human joins, shortened on second', () => {
    const r = new RoomCore();
    r.addHuman('c1', 'A', '#3aa0ff');
    const afterFirst = r.startsIn;
    expect(afterFirst).toBeGreaterThan(0);
    r.addHuman('c2', 'B', '#ff4040');
    expect(r.startsIn).toBeLessThanOrEqual(afterFirst);
    expect(r.startsIn).toBeLessThanOrEqual(12);
  });

  it('removeHuman during WAITING removes the slot', () => {
    const r = new RoomCore();
    r.addHuman('c1', 'A', '#3aa0ff');
    r.removeHuman('c1');
    expect(r.players.size).toBe(0);
  });

  it('startRace fills with bots up to MAX_RACERS', () => {
    const r = new RoomCore();
    r.addHuman('c1', 'A', '#3aa0ff');
    r.startRace();
    expect(r.players.size).toBe(MAX_RACERS);
    expect(r.vehicles.size).toBe(MAX_RACERS);
    expect(r.phase).toBe('COUNTDOWN');
  });

  it('countdown elapses then RACING', () => {
    const r = new RoomCore();
    r.addHuman('c1', 'A', '#3aa0ff');
    r.startRace();
    // Countdown is COUNTDOWN_S seconds.
    let phase = r.phase;
    for (let i = 0; i < 200; i++) {
      r.step(1 / 30);
      phase = r.phase;
      if (phase === 'RACING') break;
    }
    expect(phase).toBe('RACING');
  });

  it('snapshot cadence emits at most ~20Hz', () => {
    const r = new RoomCore('mute-avenue', 50);
    r.addHuman('c1', 'A', '#3aa0ff');
    r.startRace();
    // Reach RACING quickly.
    while (r.phase !== 'RACING') r.step(1 / 30);
    let snapshots = 0;
    let totalTime = 0;
    while (totalTime < 1) {
      const out = r.step(1 / 30);
      if (out.snapshot) snapshots++;
      totalTime += 1 / 30;
    }
    expect(snapshots).toBeGreaterThan(15);
    expect(snapshots).toBeLessThanOrEqual(25);
  });

  it('applyInput reaches the player vehicle', () => {
    const r = new RoomCore();
    const { id } = r.addHuman('c1', 'A', '#3aa0ff');
    r.startRace();
    while (r.phase !== 'RACING') r.step(1 / 30);
    r.applyInput(
      'c1',
      decodeInput(
        encodeInput({
          throttle: 1,
          steer: 0,
          boost: false,
          spin: false,
          sideLeft: false,
          sideRight: false,
          skyway: false,
        }),
      ),
    );
    r.step(1 / 30);
    const v = r.vehicles.get(id);
    expect(v).toBeDefined();
    expect(v!.power).toBeGreaterThan(0);
  });

  it('disconnecting mid-race converts the player to a bot', () => {
    const r = new RoomCore();
    r.addHuman('c1', 'A', '#3aa0ff');
    r.startRace();
    while (r.phase !== 'RACING') r.step(1 / 30);
    const before = r.players.size;
    r.removeHuman('c1');
    expect(r.players.size).toBe(before);
    const stillThere = [...r.players.values()].find((p) => p.connId === 'c1');
    expect(stillThere).toBeUndefined();
    const botified = [...r.players.values()].some((p) => p.bot);
    expect(botified).toBe(true);
  });

  it('snapshot ships count equals MAX_RACERS during a race', () => {
    const r = new RoomCore();
    r.addHuman('c1', 'A', '#3aa0ff');
    r.startRace();
    while (r.phase !== 'RACING') r.step(1 / 30);
    let snap = null;
    while (snap === null) {
      const out = r.step(1 / 30);
      if (out.snapshot) snap = out.snapshot;
    }
    if (snap.type === 'snapshot') {
      expect(snap.ships.length).toBe(MAX_RACERS);
    }
  });

  it('rejects join after racing started', () => {
    const r = new RoomCore();
    r.addHuman('c1', 'A', '#3aa0ff');
    r.startRace();
    expect(() => r.addHuman('c2', 'B', '#ff4040')).toThrow();
  });
});
