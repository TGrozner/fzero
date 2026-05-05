/**
 * Career-long aggregate stats: races completed, wins, podiums, KOs scored,
 * deaths. Persisted in localStorage so they survive reloads but stay on
 * this device. A race contributes one entry, applied when the local
 * client receives the results message for a race they were part of.
 */

const KEY = 'neon-drift:career-stats';

export type CareerStats = {
  readonly races: number;
  readonly wins: number;
  readonly podiums: number;
  readonly kos: number;
  readonly deaths: number;
};

export const EMPTY_STATS: CareerStats = {
  races: 0,
  wins: 0,
  podiums: 0,
  kos: 0,
  deaths: 0,
};

const isFiniteNonNegative = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0;

export const loadCareerStats = (): CareerStats => {
  if (typeof localStorage === 'undefined') return EMPTY_STATS;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY_STATS;
    const parsed = JSON.parse(raw) as Partial<CareerStats>;
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_STATS;
    return {
      races: isFiniteNonNegative(parsed.races) ? parsed.races : 0,
      wins: isFiniteNonNegative(parsed.wins) ? parsed.wins : 0,
      podiums: isFiniteNonNegative(parsed.podiums) ? parsed.podiums : 0,
      kos: isFiniteNonNegative(parsed.kos) ? parsed.kos : 0,
      deaths: isFiniteNonNegative(parsed.deaths) ? parsed.deaths : 0,
    };
  } catch {
    return EMPTY_STATS;
  }
};

export const saveCareerStats = (stats: CareerStats): void => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(stats));
  } catch {
    // ignore quota / private mode
  }
};

export type RaceOutcome = {
  /** 1-indexed finishing position (or null if KO'd). */
  readonly position: number | null;
  /** True if the local player was KO'd before finishing. */
  readonly ko: boolean;
  /** KOs scored by the local player during the race. */
  readonly kosScored: number;
  /** Total racers in the race (used to filter trivial 1-person "wins"). */
  readonly totalRacers: number;
};

/**
 * Pure update: returns a new CareerStats with `outcome` applied. Wins only
 * count when the race had at least 2 racers — solo runs against the empty
 * grid would otherwise inflate the count.
 */
export const applyRaceOutcome = (
  stats: CareerStats,
  outcome: RaceOutcome,
): CareerStats => ({
  races: stats.races + 1,
  wins:
    stats.wins +
    (outcome.position === 1 && !outcome.ko && outcome.totalRacers > 1 ? 1 : 0),
  podiums:
    stats.podiums +
    (outcome.position !== null &&
    outcome.position <= 3 &&
    !outcome.ko &&
    outcome.totalRacers > 1
      ? 1
      : 0),
  kos: stats.kos + outcome.kosScored,
  deaths: stats.deaths + (outcome.ko ? 1 : 0),
});
