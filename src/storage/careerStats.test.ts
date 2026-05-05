import { describe, it, expect } from 'vitest';
import { applyRaceOutcome, EMPTY_STATS } from './careerStats.ts';

describe('applyRaceOutcome', () => {
  it('counts a 1st-place finish as a win and a podium', () => {
    const out = applyRaceOutcome(EMPTY_STATS, {
      position: 1,
      ko: false,
      kosScored: 2,
      totalRacers: 5,
    });
    expect(out).toEqual({ races: 1, wins: 1, podiums: 1, kos: 2, deaths: 0 });
  });

  it('counts a 3rd-place finish as a podium but not a win', () => {
    const out = applyRaceOutcome(EMPTY_STATS, {
      position: 3,
      ko: false,
      kosScored: 0,
      totalRacers: 99,
    });
    expect(out.wins).toBe(0);
    expect(out.podiums).toBe(1);
  });

  it('does not award a win for a solo race', () => {
    const out = applyRaceOutcome(EMPTY_STATS, {
      position: 1,
      ko: false,
      kosScored: 0,
      totalRacers: 1,
    });
    expect(out.wins).toBe(0);
    expect(out.podiums).toBe(0);
    expect(out.races).toBe(1);
  });

  it('counts a KO as a death and never as a win', () => {
    const out = applyRaceOutcome(EMPTY_STATS, {
      position: 1,
      ko: true,
      kosScored: 4,
      totalRacers: 99,
    });
    expect(out.wins).toBe(0);
    expect(out.deaths).toBe(1);
    expect(out.kos).toBe(4);
  });
});
