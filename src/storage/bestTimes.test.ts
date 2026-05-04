import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadBestTimes,
  updateLap,
  updateRace,
  saveBestTimes,
  formatTimeMs,
} from './bestTimes.ts';

describe('updateLap', () => {
  it('records first lap as a PB', () => {
    const r = updateLap({}, 'mute-avenue', 12345);
    expect(r.improved).toBe(true);
    expect(r.store['mute-avenue']?.bestLapMs).toBe(12345);
  });

  it('improves when new lap is faster', () => {
    const store = updateLap({}, 'mute-avenue', 20000).store;
    const r = updateLap(store, 'mute-avenue', 18000);
    expect(r.improved).toBe(true);
    expect(r.store['mute-avenue']?.bestLapMs).toBe(18000);
  });

  it('rejects equal or slower laps', () => {
    const store = updateLap({}, 'big-blue', 18000).store;
    expect(updateLap(store, 'big-blue', 18000).improved).toBe(false);
    expect(updateLap(store, 'big-blue', 19000).improved).toBe(false);
  });

  it('rejects non-finite or non-positive times', () => {
    expect(updateLap({}, 't', 0).improved).toBe(false);
    expect(updateLap({}, 't', -10).improved).toBe(false);
    expect(updateLap({}, 't', NaN).improved).toBe(false);
    expect(updateLap({}, 't', Infinity).improved).toBe(false);
  });

  it('preserves other tracks', () => {
    let store = updateLap({}, 'a', 1000).store;
    store = updateLap(store, 'b', 2000).store;
    expect(store['a']?.bestLapMs).toBe(1000);
    expect(store['b']?.bestLapMs).toBe(2000);
  });
});

describe('updateRace', () => {
  it('records and improves race-time PBs independently of lap PBs', () => {
    const store = updateLap({}, 'mute-avenue', 9999).store;
    const r = updateRace(store, 'mute-avenue', 35000);
    expect(r.improved).toBe(true);
    expect(r.store['mute-avenue']?.bestRaceMs).toBe(35000);
    expect(r.store['mute-avenue']?.bestLapMs).toBe(9999);
  });
});

describe('formatTimeMs', () => {
  it('formats sub-minute', () => {
    expect(formatTimeMs(12345)).toBe('0:12.35');
  });
  it('zero-pads sub-second values', () => {
    expect(formatTimeMs(950)).toBe('0:00.95');
  });
  it('handles >1min', () => {
    expect(formatTimeMs(73210)).toBe('1:13.21');
  });
});

describe('localStorage round-trip', () => {
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  it('persists and reloads PBs', () => {
    if (typeof localStorage === 'undefined') return;
    const initial = updateLap({}, 'mute-avenue', 17000).store;
    saveBestTimes(initial);
    const back = loadBestTimes();
    expect(back['mute-avenue']?.bestLapMs).toBe(17000);
  });

  it('returns empty when no record', () => {
    expect(loadBestTimes()).toEqual({});
  });

  it('survives malformed JSON gracefully', () => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem('neon-drift:best-times', 'not-json');
    expect(loadBestTimes()).toEqual({});
  });
});
