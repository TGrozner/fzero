/** Maximum players (humans + bots) per room. */
export const MAX_RACERS = 99;

/** Vehicle collision radius. */
export const VEHICLE_RADIUS = 5;

/** Number of laps in a race. */
export const TOTAL_LAPS = 3;

/** Server simulation tick rate (alarm fires this often + snapshot is broadcast).
 *  10 Hz keeps inputs feeling responsive on a racing game; the client still
 *  interpolates between snapshots to smooth the gap. Each alarm = one DO
 *  request, so doubling this also doubles consumption — at current cadence
 *  we're still well under 10 % of the daily Workers free tier. */
export const SERVER_TICK_HZ = 10;
export const SERVER_TICK_MS = 1000 / SERVER_TICK_HZ;

/** Snapshot broadcast rate — aligned with the alarm tick so we emit one per fire. */
export const SERVER_SNAPSHOT_HZ = SERVER_TICK_HZ;
export const SERVER_SNAPSHOT_MS = 1000 / SERVER_SNAPSHOT_HZ;

/** Race auto-abandons after this many seconds without any human input. */
export const NO_INPUT_ABANDON_S = 60;

/** Lobby auto-start delay after the second player joins (seconds). */
export const LOBBY_AUTOSTART_S = 20;

/** Countdown before race starts (seconds). */
export const COUNTDOWN_S = 3;

/** Threshold below which "last-N boost" triggers. */
export const LAST_N_BOOST_THRESHOLD = 20;
export const LAST_N_BOOST_DURATION_S = 3;

/** Skyway parameters. */
export const SKYWAY_DURATION_S = 5;
export const SKYWAY_SPEED_BONUS = 1.3;

/** KO meter charge per checkpoint and per KO. */
export const KO_METER_PER_CHECKPOINT = 0.06;
export const KO_METER_PER_KO = 0.25;

/** Seconds of spawn protection at the start of a race (no damage taken). */
export const SPAWN_PROTECTION_S = 2.5;

/** Damage parameters. */
export const SPIN_ATTACK_RADIUS = 12;
export const SPIN_ATTACK_DAMAGE = 0.18;
export const SPIN_ATTACK_COOLDOWN_S = 1.2;

export const SIDE_ATTACK_RANGE = 10;
export const SIDE_ATTACK_IMPULSE = 280;
export const SIDE_ATTACK_DAMAGE = 0.12;
export const SIDE_ATTACK_COOLDOWN_S = 1.0;

export const WALL_DAMAGE_FACTOR = 0.0025;
export const OFF_TRACK_DAMAGE_PER_S = 0.18;

export const BOOST_HP_DRAIN_PER_S = 0.22;
export const BOOST_SPEED_MULT = 1.6;

/** Room phase strings. */
export type RoomPhase = 'WAITING' | 'COUNTDOWN' | 'RACING' | 'FINISHED';

/**
 * Ship classes — three trade-off profiles. Tuned so each one has a clear
 * niche on the existing tracks:
 *   • speed: fastest top speed + hardest to turn, slightly less HP
 *   • tank:  slowest but tightest steering and the most HP-on-impact margin
 *   • balanced: middle of the road
 */
export type ShipClass = 'speed' | 'tank' | 'balanced';
export const SHIP_CLASSES: readonly ShipClass[] = ['speed', 'tank', 'balanced'];
export const DEFAULT_SHIP_CLASS: ShipClass = 'balanced';

/** Perfect-start mechanic: full-throttle at the GO moment grants this much
 *  free boost: an arcade-style rocket-start mechanic. */
export const PERFECT_START_WINDOW_S = 0.18;
export const PERFECT_START_BOOST_S = 1.5;

/** Default colors users can pick for their ship. */
export const SHIP_COLORS: readonly string[] = [
  '#3aa0ff',
  '#ff4040',
  '#3eff8b',
  '#ffd23a',
  '#c83aff',
  '#ff8a3a',
  '#3affe1',
  '#ff3ad1',
];

/** WebSocket close codes used by the server. */
export const WS_CLOSE_ROOM_FULL = 4001;
export const WS_CLOSE_PROTOCOL_ERROR = 4002;
export const WS_CLOSE_GAME_OVER = 4003;
export const WS_CLOSE_RATE_LIMITED = 4004;

/**
 * Per-socket message rate cap. Client sends inputs at ~10 Hz; we leave ~3x
 * headroom for jitter and one-off pings. Anything beyond is treated as abuse
 * and the socket gets closed — keeps Durable Object request counts bounded
 * even under a misbehaving / hostile client.
 */
export const WS_INPUT_RATE_LIMIT_PER_S = 30;
/** Max raw WS frame size accepted from a client (bytes). Inputs are tiny. */
export const WS_MAX_MESSAGE_BYTES = 1024;
/** Max characters in a user-supplied room name. */
export const MAX_ROOM_NAME_LEN = 32;
/** Allowed characters in a room name (alphanumeric, dash, underscore). */
export const ROOM_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
