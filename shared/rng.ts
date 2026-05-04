/**
 * Mulberry32 — small, fast, deterministic seeded RNG.
 */
export type Rng = {
  next: () => number;
  int: (min: number, max: number) => number;
  range: (min: number, max: number) => number;
  pick: <T>(arr: readonly T[]) => T;
  bool: (probability?: number) => boolean;
  seed: () => number;
};

export const createRng = (initialSeed: number): Rng => {
  let state = initialSeed >>> 0;
  const seed = state;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => {
    if (max < min) throw new Error('rng.int: max < min');
    return Math.floor(next() * (max - min + 1)) + min;
  };
  const range = (min: number, max: number): number => min + next() * (max - min);
  const pick = <T>(arr: readonly T[]): T => {
    if (arr.length === 0) throw new Error('rng.pick: empty array');
    const idx = Math.floor(next() * arr.length);
    return arr[idx] as T;
  };
  const bool = (p = 0.5): boolean => next() < p;
  return { next, int, range, pick, bool, seed: () => seed };
};

/**
 * Hash a string into a 32-bit unsigned integer (xfnv1a).
 * Useful to seed the RNG from a string identifier (player id, room name, etc).
 */
export const hashString = (str: string): number => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return h >>> 0;
};
