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

  it('auto-abandons the race after the no-input timeout', () => {
    const r = new RoomCore('mute-avenue', undefined, 0.5);
    r.addHuman('c1', 'A', '#3aa0ff');
    r.noInputAbandonS = 1; // shorter for test
    r.startRace();
    // Drive past countdown.
    while ((r.phase as string) !== 'RACING') r.step(0.1);
    // No input ever arrives — race auto-finishes once raceTime > 1.
    for (let i = 0; i < 200 && (r.phase as string) !== 'FINISHED'; i++) {
      r.step(0.05);
    }
    expect(r.phase).toBe('FINISHED');
  });

  it('grants perfect-start free boost to vehicles holding throttle at GO', () => {
    const r = new RoomCore('mute-avenue', undefined, 0.5);
    const { id } = r.addHuman('c1', 'A', '#3aa0ff');
    r.startRace();
    while (r.phase !== 'COUNTDOWN') r.step(1 / 30);
    // Send full-throttle input BEFORE the GO transition.
    r.applyInput('c1', {
      throttle: 1,
      steer: 0,
      boost: false,
      spin: false,
      sideLeft: false,
      sideRight: false,
      skyway: false,
    });
    const events: string[] = [];
    while ((r.phase as string) !== 'RACING') {
      const out = r.step(1 / 30);
      for (const ev of out.events) events.push(ev.type);
    }
    expect(events).toContain('perfect-start');
    const v = r.vehicles.get(id);
    expect(v?.freeBoostUntil).toBeGreaterThan(0);
  });

  it('does NOT grant perfect-start when no input was sent before GO', () => {
    const r = new RoomCore('mute-avenue', undefined, 0.5);
    const { id } = r.addHuman('c1', 'A', '#3aa0ff');
    r.startRace();
    const events: string[] = [];
    while ((r.phase as string) !== 'RACING') {
      const out = r.step(1 / 30);
      for (const ev of out.events) events.push(ev.type);
    }
    expect(events).not.toContain('perfect-start');
    const v = r.vehicles.get(id);
    expect(v?.freeBoostUntil).toBe(0);
  });

  it('lets a disconnected client reclaim its vehicle via session token', () => {
    const r = new RoomCore();
    const { id: pid } = r.addHuman('c1', 'Tom', '#3aa0ff', 'sess-1');
    r.startRace();
    while (r.phase !== 'RACING') r.step(1 / 30);
    // Disconnect — entry stays as a bot.
    r.removeHuman('c1');
    const stale = r.players.get(pid);
    expect(stale?.bot).toBe(true);
    expect(stale?.session).toBe('sess-1');
    // Reconnect with a different connId but same session token.
    const result = r.addHuman('c2', 'Tom', '#3aa0ff', 'sess-1');
    expect(result.id).toBe(pid);
    expect(result.reconnected).toBe(true);
    const reclaimed = r.players.get(pid);
    expect(reclaimed?.bot).toBe(false);
    expect(reclaimed?.connId).toBe('c2');
  });

  it('refuses a fresh join mid-race even with a session, if no slot matches', () => {
    const r = new RoomCore();
    r.addHuman('c1', 'A', '#3aa0ff', 'sess-A');
    r.startRace();
    while (r.phase !== 'RACING') r.step(1 / 30);
    expect(() => r.addHuman('c9', 'B', '#ff4040', 'sess-NEW')).toThrow();
  });

  it('auto-abandons immediately when last human leaves mid-race', () => {
    const r = new RoomCore('mute-avenue', undefined, 0.5);
    r.addHuman('c1', 'A', '#3aa0ff');
    r.startRace();
    while ((r.phase as string) !== 'RACING') r.step(0.1);
    r.removeHuman('c1');
    // After remove, the human is converted to a bot. Force a tick: the
    // 'humansLeft === 0' branch should kick in.
    r.step(0.1);
    expect(r.phase).toBe('FINISHED');
  });
});
