/**
 * Per-track personal-best store. Lives in localStorage so PBs survive
 * reloads but stay on this device. Two fields per track:
 *   - bestLapMs: fastest single-lap split
 *   - bestRaceMs: fastest full-race finish time
 * Both are stored in milliseconds so the JSON survives floating-point
 * drift across saves.
 */

const KEY = 'neon-drift:best-times';

export type TrackBest = {
  /** Fastest single-lap split, in milliseconds. null if never set. */
  readonly bestLapMs: number | null;
  /** Fastest full-race finish time, in milliseconds. null if never set. */
  readonly bestRaceMs: number | null;
};

export type BestTimesStore = Readonly<Record<string, TrackBest>>;

const EMPTY: BestTimesStore = {};

export const loadBestTimes = (): BestTimesStore => {
  if (typeof localStorage === 'undefined') return EMPTY;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return EMPTY;
    const out: Record<string, TrackBest> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null) continue;
      const obj = v as Partial<TrackBest>;
      out[k] = {
        bestLapMs: typeof obj.bestLapMs === 'number' && obj.bestLapMs > 0 ? obj.bestLapMs : null,
        bestRaceMs:
          typeof obj.bestRaceMs === 'number' && obj.bestRaceMs > 0 ? obj.bestRaceMs : null,
      };
    }
    return out;
  } catch {
    return EMPTY;
  }
};

const persist = (store: BestTimesStore): void => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // ignore
  }
};

/**
 * Pure update — returns a new store with the proposed time merged.
 * Returns `{store, improved}` so callers can react to a fresh PB.
 */
export const updateLap = (
  store: BestTimesStore,
  trackId: string,
  lapMs: number,
): { store: BestTimesStore; improved: boolean } => {
  if (lapMs <= 0 || !Number.isFinite(lapMs)) return { store, improved: false };
  const current = store[trackId] ?? { bestLapMs: null, bestRaceMs: null };
  if (current.bestLapMs !== null && current.bestLapMs <= lapMs) {
    return { store, improved: false };
  }
  const next: BestTimesStore = {
    ...store,
    [trackId]: { ...current, bestLapMs: lapMs },
  };
  return { store: next, improved: true };
};

export const updateRace = (
  store: BestTimesStore,
  trackId: string,
  raceMs: number,
): { store: BestTimesStore; improved: boolean } => {
  if (raceMs <= 0 || !Number.isFinite(raceMs)) return { store, improved: false };
  const current = store[trackId] ?? { bestLapMs: null, bestRaceMs: null };
  if (current.bestRaceMs !== null && current.bestRaceMs <= raceMs) {
    return { store, improved: false };
  }
  const next: BestTimesStore = {
    ...store,
    [trackId]: { ...current, bestRaceMs: raceMs },
  };
  return { store: next, improved: true };
};

export const saveBestTimes = (store: BestTimesStore): void => persist(store);

/** Format milliseconds as m:ss.ff — used for HUD/menu display. */
export const formatTimeMs = (ms: number): string => {
  const totalSecs = ms / 1000;
  const mins = Math.floor(totalSecs / 60);
  const secs = (totalSecs - mins * 60).toFixed(2);
  const padded = secs.padStart(5, '0');
  return `${mins}:${padded}`;
};
