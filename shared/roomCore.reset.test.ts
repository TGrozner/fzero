import { describe, it, expect } from 'vitest';
import { RoomCore } from './roomCore.ts';
import type { RoomPhase } from './constants.ts';

describe('RoomCore post-race reset', () => {
  it('resetToWaiting wipes state and accepts new joins', () => {
    const r = new RoomCore('mute-avenue', 50, 0.5);
    r.addHuman('c1', 'A', '#3aa0ff');
    r.startRace();
    // Force-finish the race.
    r.phase = 'FINISHED';
    r.resetToWaiting();
    expect(r.phase).toBe('WAITING');
    expect(r.players.size).toBe(0);
    expect(r.vehicles.size).toBe(0);
    expect(() => r.addHuman('c2', 'B', '#ff4040')).not.toThrow();
  });

  it('FINISHED auto-resets after cooldown', () => {
    const r = new RoomCore('mute-avenue', 50, 0.5);
    r.addHuman('c1', 'A', '#3aa0ff');
    r.startRace();
    r.phase = 'FINISHED';
    r.finishedCooldownS = 1;
    for (let i = 0; i < 200; i++) {
      r.step(0.1);
      if ((r.phase as RoomPhase) === 'WAITING') break;
    }
    expect(r.phase).toBe('WAITING');
    expect(r.players.size).toBe(0);
  });
});
