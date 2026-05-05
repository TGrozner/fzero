import { angleOf } from './vec2.ts';
import {
  COUNTDOWN_S,
  DEFAULT_SHIP_CLASS,
  LOBBY_AUTOSTART_S,
  MAX_RACERS,
  NO_INPUT_ABANDON_S,
  PERFECT_START_BOOST_S,
  type RoomPhase,
  SERVER_SNAPSHOT_MS,
  SHIP_CLASSES,
  SHIP_COLORS,
  type ShipClass,
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
import {
  type PickupSpec,
  applyPickups,
  defaultPickups,
  pickupWorldPos,
} from './pickups.ts';
import type { Vec2 } from './vec2.ts';
import {
  type ActivePickup,
  botColor,
  botInput,
  botName,
  profileForId,
} from './bot.ts';
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
  readonly connId: string | null; // null = bot or disconnected
  readonly name: string;
  readonly color: string;
  readonly bot: boolean;
  readonly cls: ShipClass;
  /**
   * Stable per-client session token. When a connection drops mid-race the
   * entry is converted to a bot but `session` is preserved so the same
   * client can reclaim its vehicle by sending the same token in `hello`.
   */
  readonly session: string | null;
  /** Lobby ready flag. When all humans are ready the race auto-starts. */
  readonly ready: boolean;
  /** Last reported round-trip time in ms, or null if not measured. */
  readonly rtt: number | null;
  /** Track the player wants to play. Default = room's track on join. */
  readonly trackVote: string;
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
/** Lap counts the lobby UI exposes — anything else is rejected by setLaps. */
export const ALLOWED_LAPS: readonly number[] = [1, 2, 3, 5];

export class RoomCore {
  phase: RoomPhase = 'WAITING';
  track: Track;
  totalLaps: number = TOTAL_LAPS;
  config = buildRaceConfig(TRACKS[0] as Track, TOTAL_LAPS);
  players = new Map<string, PlayerEntry>();
  /** Reverse lookup: connId → playerId for O(1) input routing. */
  private connToPlayer = new Map<string, string>();
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
  /** Authored pickup layout for the active track. */
  pickupLayout: readonly PickupSpec[] = [];
  /** Cached world-space positions, parallel to pickupLayout. */
  private pickupPositions: Vec2[] = [];
  /** raceTime at which each pickup re-activates; <= current means active. */
  private pickupRespawnAt: number[] = [];

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
    this.config = buildRaceConfig(this.track, this.totalLaps);
    this.snapIntervalMs = snapIntervalMs;
    if (lobbyAutoStartS !== undefined) this.lobbyAutoStartS = lobbyAutoStartS;
    this.rebuildPickups();
  }

  private rebuildPickups(): void {
    this.pickupLayout = defaultPickups(this.track);
    this.pickupPositions = this.pickupLayout.map((spec) => pickupWorldPos(this.track, spec));
    this.pickupRespawnAt = this.pickupLayout.map(() => 0);
  }

  /** Bitmask of currently-active pickups (bit i = pad i is alive). */
  pickupActiveMask(): number {
    let mask = 0;
    for (let i = 0; i < this.pickupLayout.length && i < 32; i++) {
      if ((this.pickupRespawnAt[i] ?? 0) <= this.raceTime) mask |= 1 << i;
    }
    return mask;
  }

  /**
   * Add a human player. Returns the assigned player id and welcome message.
   * If `session` matches an existing entry that's currently bot-controlled
   * (i.e. the client previously disconnected), reclaims that entry instead
   * of allocating a new one — even mid-race.
   */
  addHuman(
    connId: string,
    name: string,
    color: string,
    session: string | null = null,
    cls: ShipClass = DEFAULT_SHIP_CLASS,
  ): { id: string; welcome: ServerMessage; reconnected: boolean } {
    // Reconnection path: same session token, currently bot-piloted.
    if (session) {
      for (const [pid, entry] of this.players) {
        if (entry.session === session && entry.bot) {
          this.players.set(pid, {
            ...entry,
            connId,
            bot: false,
            ready: false,
            rtt: null,
            trackVote: this.track.id,
          });
          this.connToPlayer.set(connId, pid);
          // Resume normal input processing for this vehicle.
          if (!this.inputs.has(pid)) this.inputs.set(pid, NEUTRAL_INPUT);
          this.lastHumanInputAt = this.raceTime;
          return {
            id: pid,
            reconnected: true,
            welcome: {
              type: 'welcome',
              yourId: pid,
              track: this.track.id,
              laps: this.totalLaps,
              players: this.playerInfos(),
              phase: this.phase,
              countdown: this.countdown,
              startsIn: this.startsIn,
              reconnected: true,
            },
          };
        }
      }
    }
    if (this.players.size >= MAX_RACERS) {
      throw new Error('room full');
    }
    if (this.phase !== 'WAITING') {
      throw new Error('race already started');
    }
    const id = nextId('p');
    const safeName = sanitizeName(name) || `Pilot ${this.players.size + 1}`;
    const safeColor = SHIP_COLORS.includes(color) ? color : (SHIP_COLORS[0] as string);
    const safeCls: ShipClass = SHIP_CLASSES.includes(cls) ? cls : DEFAULT_SHIP_CLASS;
    this.players.set(id, {
      id,
      connId,
      name: safeName,
      color: safeColor,
      bot: false,
      cls: safeCls,
      session,
      ready: false,
      rtt: null,
      trackVote: this.track.id,
    });
    this.connToPlayer.set(connId, id);
    // No auto-start by default — players use the Start now button or the
    // per-player Ready flag to trigger the race when they're good to go.
    return {
      id,
      reconnected: false,
      welcome: {
        type: 'welcome',
        yourId: id,
        track: this.track.id,
        laps: this.totalLaps,
        players: this.playerInfos(),
        phase: this.phase,
        countdown: this.countdown,
        startsIn: this.startsIn,
      },
    };
  }

  /** Remove a player by their connection id. */
  removeHuman(connId: string): void {
    const pid = this.connToPlayer.get(connId);
    if (pid === undefined) return;
    const entry = this.players.get(pid);
    if (!entry) return;
    this.connToPlayer.delete(connId);
    if (this.phase === 'WAITING') {
      // Drop fully if not yet racing.
      this.players.delete(pid);
      this.vehicles.delete(pid);
      this.inputs.delete(pid);
    } else {
      // Mid-race: convert to a bot so the race continues without them.
      // `session` is preserved so the same client can reconnect and
      // reclaim this vehicle.
      this.players.set(pid, { ...entry, connId: null, bot: true });
    }
    const humans = [...this.players.values()].filter((p) => !p.bot).length;
    if (humans === 0) this.startsIn = -1;
  }

  /** Apply input from a connection id to the corresponding player. */
  applyInput(connId: string, input: VehicleInput): void {
    const pid = this.connToPlayer.get(connId);
    if (pid === undefined) return;
    this.inputs.set(pid, input);
    // Track activity so we can auto-abandon idle rooms (DO requests aren't free).
    const entry = this.players.get(pid);
    if (entry && !entry.bot) this.lastHumanInputAt = this.raceTime;
  }

  /** Force start the race (e.g. countdown auto-start). Fills with bots up to MAX_RACERS. */
  startRace(): ServerMessage[] {
    if (this.phase !== 'WAITING') return [];
    // Fill bots.
    while (this.players.size < MAX_RACERS) {
      const id = nextId('b');
      // Spread bots across the three classes deterministically from id hash.
      // (botColor already uses a hash; here we use a smaller entropy source.)
      const classIdx = id.charCodeAt(id.length - 1) % SHIP_CLASSES.length;
      const cls = SHIP_CLASSES[classIdx] ?? DEFAULT_SHIP_CLASS;
      this.players.set(id, {
        id,
        connId: null,
        name: botName(id),
        color: botColor(id, SHIP_COLORS),
        bot: true,
        cls,
        session: null,
        ready: true,
        rtt: null,
        trackVote: this.track.id,
      });
    }
    // Spawn vehicles.
    const ids = [...this.players.keys()];
    const grid = startingGrid(this.track, ids.length);
    const heading = angleOf(this.track.startHeading);
    for (let i = 0; i < ids.length; i++) {
      const pid = ids[i] as string;
      const pos = grid[i] ?? this.track.startPosition;
      const entry = this.players.get(pid);
      const cls = entry?.cls ?? DEFAULT_SHIP_CLASS;
      this.vehicles.set(pid, createVehicle(pid, pos, heading, cls));
      this.inputs.set(pid, NEUTRAL_INPUT);
    }
    this.phase = 'COUNTDOWN';
    this.countdown = COUNTDOWN_S;
    this.raceTime = 0;
    this.lastHumanInputAt = 0;
    this.tick = 0;
    this.lastNTriggered = false;
    this.rebuildPickups();
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
        // Perfect-start: any vehicle whose latest input has full throttle
        // at the GO transition gets a free boost. We tag the vehicles
        // directly here so the very first racing tick already applies the
        // boost speed multiplier.
        for (const v of this.vehicles.values()) {
          const input = this.inputs.get(v.id);
          // Accept any positive throttle (>= 0.7) — leaving some leeway for
          // partial input quantisation. Bots may also get this if their
          // throttle came in pre-GO.
          if (input && input.throttle >= 0.7) {
            this.vehicles.set(v.id, {
              ...v,
              freeBoostUntil: Math.max(v.freeBoostUntil, this.raceTime + PERFECT_START_BOOST_S),
            });
            events.push({
              type: 'perfect-start',
              id: v.id,
              time: this.raceTime,
            });
          }
        }
      }
    } else if (this.phase === 'RACING') {
      // Compute bot inputs from current state. Also surface the active
      // pickup list so bots can chase heal/boost and dodge mines.
      const allVehicles = [...this.vehicles.values()];
      const activePickups: ActivePickup[] = [];
      for (let i = 0; i < this.pickupLayout.length; i++) {
        if ((this.pickupRespawnAt[i] ?? 0) > this.raceTime) continue;
        const spec = this.pickupLayout[i];
        const pos = this.pickupPositions[i];
        if (spec && pos) activePickups.push({ kind: spec.kind, pos });
      }
      for (const entry of this.players.values()) {
        if (!entry.bot) continue;
        const v = this.vehicles.get(entry.id);
        if (!v) continue;
        const others = allVehicles.filter((x) => x.id !== entry.id);
        const input = botInput(
          v,
          others,
          this.track,
          profileForId(entry.id),
          this.raceTime,
          activePickups,
        );
        this.inputs.set(entry.id, input);
      }
      this.raceTime += dt;
      this.tick += 1;
      const result = stepRace(allVehicles, this.inputs, this.config, dt, this.raceTime);
      // Pickup resolution after physics so positions reflect this frame.
      const pk = applyPickups(
        result.vehicles,
        this.pickupLayout,
        this.pickupPositions,
        this.pickupRespawnAt,
        this.raceTime,
      );
      this.pickupRespawnAt = pk.respawnAt;
      for (const v of pk.vehicles) this.vehicles.set(v.id, v);
      for (const hit of pk.hits) {
        events.push({
          type: 'pickup',
          idx: hit.idx,
          kind: hit.kind,
          vehicleId: hit.vehicleId,
          time: this.raceTime,
        });
      }
      for (const koId of pk.kos) {
        events.push({ type: 'ko', id: koId, by: null, time: this.raceTime });
      }
      // Subsequent steps use the post-pickup vehicles.
      const postPickup = pk.vehicles;
      // Last-N boost?
      const lastN = maybeTriggerLastNBoost(
        postPickup,
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
      // Non-lethal hit events (spin / side) — surfaced for client FX.
      for (const h of result.hits) {
        events.push({
          type: 'hit',
          victim: h.victimId,
          attacker: h.attackerId,
          kind: h.kind,
          x: h.x,
          y: h.y,
          time: this.raceTime,
        });
      }
      // Auto-abandon: free DO budget when no human is interacting.
      const humansLeft = [...this.players.values()].filter((p) => !p.bot).length;
      const idleSecs = this.raceTime - this.lastHumanInputAt;
      if (
        humansLeft === 0 ||
        idleSecs > this.noInputAbandonS ||
        isRaceOver(postPickup, this.config.totalLaps)
      ) {
        finishedNow = true;
        this.emitFinish(events, postPickup);
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
          pk: this.pickupActiveMask(),
        };
      }
    }

    return { snapshot, events, finishedNow };
  }

  /** Transition to FINISHED and emit results. */
  private emitFinish(events: ServerMessage[], vehicles: readonly Vehicle[]): void {
    this.phase = 'FINISHED';
    this.finishedFor = 0;
    events.push({ type: 'phase', phase: 'FINISHED' });
    events.push({
      type: 'results',
      standings: standings(vehicles).map((s) => ({
        id: s.id,
        position: s.position,
        finishTime: s.finishTime,
        ko: s.ko,
      })),
    });
  }

  /** Wipe race state and return to WAITING. Called automatically after FINISHED cooldown,
   *  or by the DO wrapper when a fresh client tries to join a finished room. */
  resetToWaiting(): void {
    this.phase = 'WAITING';
    this.players.clear();
    this.connToPlayer.clear();
    this.vehicles.clear();
    this.inputs.clear();
    this.raceTime = 0;
    this.tick = 0;
    this.countdown = COUNTDOWN_S;
    this.startsIn = -1;
    this.lastNTriggered = false;
    this.finishedFor = 0;
    this.rebuildPickups();
  }

  playerInfos() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      bot: p.bot,
      cls: p.cls,
      ready: p.ready,
      rtt: p.rtt,
      trackVote: p.trackVote,
    }));
  }

  /**
   * The "host" is the longest-connected human (insertion order in the
   * players map). They get exclusive control over Start Now and lap count.
   * Returns null if the room has no humans.
   */
  hostId(): string | null {
    for (const p of this.players.values()) {
      if (!p.bot && p.connId !== null) return p.id;
    }
    return null;
  }

  /** True if `connId` corresponds to the current host. */
  isHost(connId: string): boolean {
    const pid = this.connToPlayer.get(connId);
    return pid !== undefined && pid === this.hostId();
  }

  /**
   * Tally trackVotes among connected humans. Returns the trackId with the
   * most votes; ties (or no humans) keep the current track.
   */
  private tallyTrackWinner(): string {
    const counts = new Map<string, number>();
    for (const p of this.players.values()) {
      if (p.bot || p.connId === null) continue;
      counts.set(p.trackVote, (counts.get(p.trackVote) ?? 0) + 1);
    }
    let winner = this.track.id;
    let winnerVotes = counts.get(this.track.id) ?? 0;
    let tied = false;
    for (const [trackId, votes] of counts) {
      if (votes > winnerVotes) {
        winner = trackId;
        winnerVotes = votes;
        tied = false;
      } else if (votes === winnerVotes && trackId !== winner) {
        tied = true;
      }
    }
    return tied ? this.track.id : winner;
  }

  /** Update a player's reported RTT. No-op if rtt change is below 10 ms. */
  setRtt(connId: string, rtt: number): boolean {
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 10_000) return false;
    const pid = this.connToPlayer.get(connId);
    if (pid === undefined) return false;
    const entry = this.players.get(pid);
    if (!entry || entry.bot) return false;
    if (entry.rtt !== null && Math.abs(entry.rtt - rtt) < 10) return false;
    this.players.set(pid, { ...entry, rtt: Math.round(rtt) });
    return true;
  }

  /**
   * Toggle a human player's lobby-ready flag. Returns whether all currently
   * connected humans are now ready (caller decides whether to auto-start).
   */
  setReady(connId: string, ready: boolean): { allReady: boolean; humans: number } {
    if (this.phase !== 'WAITING') return { allReady: false, humans: 0 };
    const pid = this.connToPlayer.get(connId);
    if (pid !== undefined) {
      const entry = this.players.get(pid);
      if (entry && !entry.bot) this.players.set(pid, { ...entry, ready });
    }
    const humans = [...this.players.values()].filter((p) => !p.bot);
    return {
      allReady: humans.length > 0 && humans.every((p) => p.ready),
      humans: humans.length,
    };
  }

  /**
   * Record a player's track vote and re-tally. Returns whether the active
   * track actually changed as a result. WAITING-only so a vote can't
   * suddenly swap the track mid-race.
   */
  setTrackVote(connId: string, trackId: string): { voteRecorded: boolean; trackChanged: boolean } {
    if (this.phase !== 'WAITING') return { voteRecorded: false, trackChanged: false };
    // Validate the trackId before recording — we don't want garbage in the tally.
    try {
      findTrack(trackId);
    } catch {
      return { voteRecorded: false, trackChanged: false };
    }
    const pid = this.connToPlayer.get(connId);
    if (pid === undefined) return { voteRecorded: false, trackChanged: false };
    const entry = this.players.get(pid);
    if (!entry || entry.bot) return { voteRecorded: false, trackChanged: false };
    if (entry.trackVote === trackId) return { voteRecorded: false, trackChanged: false };
    this.players.set(pid, { ...entry, trackVote: trackId });
    const winner = this.tallyTrackWinner();
    if (winner === this.track.id) return { voteRecorded: true, trackChanged: false };
    this.applyTrack(winner);
    return { voteRecorded: true, trackChanged: true };
  }

  /**
   * Internal: actually swap the track. Caller is responsible for gating.
   * Resets ready flags (different track = different commitment) and clears
   * non-winning votes back to the new active track... no, actually we
   * preserve people's votes so they can keep advocating for their pick.
   */
  private applyTrack(trackId: string): void {
    this.track = findTrack(trackId);
    this.config = buildRaceConfig(this.track, this.totalLaps);
    this.rebuildPickups();
    for (const [pid, entry] of this.players) {
      if (entry.ready) this.players.set(pid, { ...entry, ready: false });
    }
  }

  /** Change race length. Only allowed during WAITING; resets ready flags. */
  setLaps(laps: number): boolean {
    if (this.phase !== 'WAITING') return false;
    if (!ALLOWED_LAPS.includes(laps)) return false;
    if (laps === this.totalLaps) return false;
    this.totalLaps = laps;
    this.config = buildRaceConfig(this.track, this.totalLaps);
    for (const [pid, entry] of this.players) {
      if (entry.ready) this.players.set(pid, { ...entry, ready: false });
    }
    return true;
  }

  /**
   * Change a single player's ship class in WAITING. Doesn't reset ready —
   * picking a class is your own decision and shouldn't unmark the room.
   */
  setClass(connId: string, cls: ShipClass): boolean {
    if (this.phase !== 'WAITING') return false;
    if (!SHIP_CLASSES.includes(cls)) return false;
    const pid = this.connToPlayer.get(connId);
    if (pid === undefined) return false;
    const entry = this.players.get(pid);
    if (!entry || entry.bot) return false;
    if (entry.cls === cls) return false;
    this.players.set(pid, { ...entry, cls });
    return true;
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
        sc: Math.max(0, v.spinCd),
        dc: Math.max(0, v.sideCd),
      });
    }
    return out;
  }
}

const sanitizeName = (raw: string): string => {
  return (raw || '').slice(0, 16).replace(/[^\p{L}\p{N} _-]/gu, '').trim();
};
