import { angleOf } from './vec2.ts';
import {
  COUNTDOWN_S,
  LOBBY_AUTOSTART_S,
  MAX_RACERS,
  NO_INPUT_ABANDON_S,
  type RoomPhase,
  SERVER_SNAPSHOT_MS,
  SHIP_COLORS,
  TOTAL_LAPS,
} from './constants.ts';
import {
  type Vehicle,
  type VehicleInput,
  NEUTRAL_INPUT,
  createVehicle,
} from './physics.ts';
import {
  buildRaceConfig,
  isRaceOver,
  maybeTriggerLastNBoost,
  standings,
  stepRace,
} from './race.ts';
import { findTrack, startingGrid, TRACKS, type Track } from './track.ts';
import { botColor, botInput, botName, profileForId } from './bot.ts';
import {
  type ServerMessage,
  type ShipSnapshot,
  FLAG_FINISHED,
  FLAG_FREE_BOOST,
  FLAG_KO,
  FLAG_SKYWAY,
} from './protocol.ts';

export type PlayerEntry = {
  readonly id: string;
  readonly connId: string | null; // null = bot
  readonly name: string;
  readonly color: string;
  readonly bot: boolean;
};

export type StepResult = {
  /** Snapshots are emitted at SERVER_SNAPSHOT_HZ. */
  snapshot: ServerMessage | null;
  events: ServerMessage[];
  /** True when the room transitions to FINISHED. */
  finishedNow: boolean;
};

/** Counter used to generate unique short ids ("p1", "b3", etc). */
let idCounter = 0;
const nextId = (prefix: string) => {
  idCounter += 1;
  return `${prefix}${idCounter}`;
};

/**
 * Pure-ish room core. Owns the simulation, players, and lifecycle.
 * The Durable Object wrapper is a thin shell around it.
 */
export class RoomCore {
  phase: RoomPhase = 'WAITING';
  track: Track;
  config = buildRaceConfig(TRACKS[0] as Track, TOTAL_LAPS);
  players = new Map<string, PlayerEntry>();
  /** Vehicle id → Vehicle. */
  vehicles = new Map<string, Vehicle>();
  /** Vehicle id → latest input. */
  inputs = new Map<string, VehicleInput>();
  raceTime = 0;
  tick = 0;
  countdown = COUNTDOWN_S;
  /** Seconds until lobby auto-starts. -1 if N/A (less than 2 humans). */
  startsIn = -1;
  lastNTriggered = false;
  /** Ms-accumulator for snapshot broadcast cadence. */
  private snapAccumMs = 0;
  /** Snapshot emit interval (ms). */
  private readonly snapIntervalMs: number;

  /** Override the lobby auto-start delay (defaults to LOBBY_AUTOSTART_S). */
  lobbyAutoStartS: number = LOBBY_AUTOSTART_S;
  /** Seconds to keep the FINISHED phase before auto-resetting back to WAITING. */
  finishedCooldownS = 8;
  /** Time (s) the room has been in FINISHED phase. */
  private finishedFor = 0;
  /** Race time of the most recent human input (used for idle abandon). */
  private lastHumanInputAt = 0;
  /** Seconds without any human input before the race auto-abandons. */
  noInputAbandonS = NO_INPUT_ABANDON_S;

  constructor(
    trackId: string = TRACKS[0]?.id ?? 'mute-avenue',
    snapIntervalMs = SERVER_SNAPSHOT_MS,
    lobbyAutoStartS?: number,
  ) {
    this.track = findTrack(trackId);
    this.config = buildRaceConfig(this.track, TOTAL_LAPS);
    this.snapIntervalMs = snapIntervalMs;
    if (lobbyAutoStartS !== undefined) this.lobbyAutoStartS = lobbyAutoStartS;
  }

  /** Add a human player. Returns the assigned player id and welcome message. */
  addHuman(connId: string, name: string, color: string): { id: string; welcome: ServerMessage } {
    if (this.players.size >= MAX_RACERS) {
      throw new Error('room full');
    }
    if (this.phase !== 'WAITING') {
      throw new Error('race already started');
    }
    const id = nextId('p');
    const safeName = sanitizeName(name) || `Pilot ${this.players.size + 1}`;
    const safeColor = SHIP_COLORS.includes(color) ? color : (SHIP_COLORS[0] as string);
    this.players.set(id, { id, connId, name: safeName, color: safeColor, bot: false });
    // Lobby auto-start: long timer when the first human shows up; shorten when a 2nd arrives.
    const humans = [...this.players.values()].filter((p) => !p.bot).length;
    if (humans === 1 && this.startsIn < 0) {
      this.startsIn = this.lobbyAutoStartS;
    } else if (humans >= 2) {
      this.startsIn = Math.min(
        this.startsIn < 0 ? this.lobbyAutoStartS : this.startsIn,
        Math.min(12, this.lobbyAutoStartS),
      );
    }
    return {
      id,
      welcome: {
        type: 'welcome',
        yourId: id,
        track: this.track.id,
        players: this.playerInfos(),
        phase: this.phase,
        countdown: this.countdown,
        startsIn: this.startsIn,
      },
    };
  }

  /** Remove a player by their connection id. */
  removeHuman(connId: string): void {
    for (const [pid, entry] of this.players) {
      if (entry.connId === connId) {
        if (this.phase === 'WAITING') {
          // Drop fully if not yet racing.
          this.players.delete(pid);
          this.vehicles.delete(pid);
          this.inputs.delete(pid);
        } else {
          // Mid-race: convert to a bot so the race continues without them.
          this.players.set(pid, { ...entry, connId: null, bot: true });
        }
      }
    }
    const humans = [...this.players.values()].filter((p) => !p.bot).length;
    if (humans === 0) this.startsIn = -1;
  }

  /** Apply input from a connection id to the corresponding player. */
  applyInput(connId: string, input: VehicleInput): void {
    const entry = [...this.players.values()].find((p) => p.connId === connId);
    if (!entry) return;
    this.inputs.set(entry.id, input);
    // Track activity so we can auto-abandon idle rooms (DO requests aren't free).
    if (!entry.bot) this.lastHumanInputAt = this.raceTime;
  }

  /** Force start the race (e.g. countdown auto-start). Fills with bots up to MAX_RACERS. */
  startRace(): ServerMessage[] {
    if (this.phase !== 'WAITING') return [];
    // Fill bots.
    while (this.players.size < MAX_RACERS) {
      const id = nextId('b');
      this.players.set(id, {
        id,
        connId: null,
        name: botName(id),
        color: botColor(id, SHIP_COLORS),
        bot: true,
      });
    }
    // Spawn vehicles.
    const ids = [...this.players.keys()];
    const grid = startingGrid(this.track, ids.length);
    const heading = angleOf(this.track.startHeading);
    for (let i = 0; i < ids.length; i++) {
      const pid = ids[i] as string;
      const pos = grid[i] ?? this.track.startPosition;
      this.vehicles.set(pid, createVehicle(pid, pos, heading));
      this.inputs.set(pid, NEUTRAL_INPUT);
    }
    this.phase = 'COUNTDOWN';
    this.countdown = COUNTDOWN_S;
    this.raceTime = 0;
    this.lastHumanInputAt = 0;
    this.tick = 0;
    this.lastNTriggered = false;
    return [
      { type: 'phase', phase: 'COUNTDOWN', countdown: this.countdown },
      { type: 'players', players: this.playerInfos() },
    ];
  }

  /** Step the simulation by `dt` seconds (server tick). */
  step(dt: number): StepResult {
    const events: ServerMessage[] = [];
    let finishedNow = false;

    if (this.phase === 'FINISHED') {
      this.finishedFor += dt;
      if (this.finishedFor >= this.finishedCooldownS) {
        this.resetToWaiting();
        events.push({ type: 'phase', phase: 'WAITING' });
      }
    } else if (this.phase === 'WAITING') {
      if (this.startsIn >= 0) {
        this.startsIn = Math.max(0, this.startsIn - dt);
        if (this.startsIn === 0) {
          events.push(...this.startRace());
        }
      }
    } else if (this.phase === 'COUNTDOWN') {
      const before = Math.ceil(this.countdown);
      this.countdown = Math.max(0, this.countdown - dt);
      const after = Math.ceil(this.countdown);
      if (after !== before && this.countdown > 0) {
        events.push({ type: 'phase', phase: 'COUNTDOWN', countdown: this.countdown });
      }
      if (this.countdown === 0) {
        this.phase = 'RACING';
        events.push({ type: 'phase', phase: 'RACING' });
      }
    } else if (this.phase === 'RACING') {
      // Compute bot inputs from current state.
      const allVehicles = [...this.vehicles.values()];
      for (const entry of this.players.values()) {
        if (!entry.bot) continue;
        const v = this.vehicles.get(entry.id);
        if (!v) continue;
        const others = allVehicles.filter((x) => x.id !== entry.id);
        const input = botInput(v, others, this.track, profileForId(entry.id), this.raceTime);
        this.inputs.set(entry.id, input);
      }
      this.raceTime += dt;
      this.tick += 1;
      const result = stepRace(allVehicles, this.inputs, this.config, dt, this.raceTime);
      // Update vehicles map.
      for (const v of result.vehicles) this.vehicles.set(v.id, v);
      // Last-N boost?
      const lastN = maybeTriggerLastNBoost(
        result.vehicles,
        this.raceTime,
        this.lastNTriggered,
      );
      if (lastN.triggered && !this.lastNTriggered) {
        this.lastNTriggered = true;
        for (const v of lastN.vehicles) this.vehicles.set(v.id, v);
      }
      // KO events.
      for (const ko of result.kos) {
        events.push({ type: 'ko', id: ko.id, by: ko.by, time: this.raceTime });
      }
      // Auto-abandon: free DO budget when no human is interacting.
      const humansLeft = [...this.players.values()].filter((p) => !p.bot).length;
      const idleSecs = this.raceTime - this.lastHumanInputAt;
      if (humansLeft === 0 || idleSecs > this.noInputAbandonS) {
        this.phase = 'FINISHED';
        this.finishedFor = 0;
        finishedNow = true;
        events.push({ type: 'phase', phase: 'FINISHED' });
        events.push({
          type: 'results',
          standings: standings(result.vehicles).map((s) => ({
            id: s.id,
            position: s.position,
            finishTime: s.finishTime,
            ko: s.ko,
          })),
        });
      } else if (isRaceOver(result.vehicles, this.config.totalLaps)) {
        this.phase = 'FINISHED';
        this.finishedFor = 0;
        finishedNow = true;
        events.push({ type: 'phase', phase: 'FINISHED' });
        events.push({
          type: 'results',
          standings: standings(result.vehicles).map((s) => ({
            id: s.id,
            position: s.position,
            finishTime: s.finishTime,
            ko: s.ko,
          })),
        });
      }
    }

    // Snapshot cadence.
    let snapshot: ServerMessage | null = null;
    if (this.phase === 'RACING' || this.phase === 'COUNTDOWN') {
      this.snapAccumMs += dt * 1000;
      if (this.snapAccumMs >= this.snapIntervalMs) {
        this.snapAccumMs = 0;
        snapshot = {
          type: 'snapshot',
          tick: this.tick,
          time: this.raceTime,
          ships: this.snapshotShips(),
          racersLeft: [...this.vehicles.values()].filter((v) => !v.ko && !v.finished).length,
        };
      }
    }

    return { snapshot, events, finishedNow };
  }

  /** Wipe race state and return to WAITING. Called automatically after FINISHED cooldown,
   *  or by the DO wrapper when a fresh client tries to join a finished room. */
  resetToWaiting(): void {
    this.phase = 'WAITING';
    this.players.clear();
    this.vehicles.clear();
    this.inputs.clear();
    this.raceTime = 0;
    this.tick = 0;
    this.countdown = COUNTDOWN_S;
    this.startsIn = -1;
    this.lastNTriggered = false;
    this.finishedFor = 0;
  }

  playerInfos() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      bot: p.bot,
    }));
  }

  snapshotShips(): ShipSnapshot[] {
    const out: ShipSnapshot[] = [];
    for (const v of this.vehicles.values()) {
      let f = 0;
      if (v.skywayUntil > this.raceTime) f |= FLAG_SKYWAY;
      if (v.freeBoostUntil > this.raceTime) f |= FLAG_FREE_BOOST;
      if (v.ko) f |= FLAG_KO;
      if (v.finished) f |= FLAG_FINISHED;
      out.push({
        id: v.id,
        x: v.pos.x,
        y: v.pos.y,
        h: v.heading,
        vx: v.vel.x,
        vy: v.vel.y,
        p: v.power,
        k: v.koMeter,
        l: v.lap,
        a: v.arcLength,
        f,
      });
    }
    return out;
  }
}

const sanitizeName = (raw: string): string => {
  return (raw || '').slice(0, 16).replace(/[^\p{L}\p{N} _-]/gu, '').trim();
};
