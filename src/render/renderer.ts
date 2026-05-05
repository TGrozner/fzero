/**
 * Render-loop profiling notes (Canvas2D). Hot paths the in-browser FPS
 * overlay (`?profile=1`) and `vitest bench` flag:
 *
 *   • drawTrack: O(SUBS * (SEGMENTS_AHEAD + SEGMENTS_BEHIND)) per frame plus
 *     two passes of per-segment decoration. Dominates at 99 ships and is
 *     mostly fill-rate / `ctx.fill` cost.
 *   • drawTrails: O(ships * trailLen) project + stroke. `shadowBlur` is
 *     non-negligible — keep it small (~6).
 *   • drawShip: per-ship `ctx.save`/`restore` + `transform` is ~60 calls per
 *     frame. Switching to a single batched transform / instanced WebGL pipe
 *     would reclaim the per-call overhead.
 *
 * WebGL upgrade plan (for future work):
 *   1. Move ground (track + decorations + grid) to a single textured quad
 *      with per-pixel perspective in a fragment shader. Eliminates the
 *      per-rib polygon allocation each frame.
 *   2. Move ship + trail + particle batches to instanced quads. With ~99
 *      ships, ~600 particles, ~99*8 trail segments the draw-call count is
 *      already in the thousands per frame; a single instanced draw collapses
 *      it to one.
 *   3. The 2D HUD stays on Canvas2D — no benefit moving it.
 */
import type { ShipSnapshot } from '../../shared/protocol.ts';
import { FLAG_FREE_BOOST, FLAG_KO, FLAG_SKYWAY } from '../../shared/protocol.ts';
import type { Track } from '../../shared/track.ts';
import { closestOnTrack, edgePoint } from '../../shared/track.ts';
import { type ClientState, type PickupEvent, type HitEvent, spectatorTargetId } from '../state.ts';
import { findTrack } from '../../shared/track.ts';
import { type PlayerInfoMsg } from '../../shared/protocol.ts';
import { lerpAngle, wrapAngle } from '../../shared/vec2.ts';
import { defaultPickups, pickupWorldPos, type PickupSpec } from '../../shared/pickups.ts';

export type RenderContext = {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
};

/** Pseudo-3D camera (Mode 7-style) parameters. */
type CamConfig = {
  height: number;
  distBehind: number;
  focal: number;
  horizonY: number;
};

type CamPose = {
  posX: number;
  posY: number;
  /** Camera looking direction (radians, 0 = +x). */
  heading: number;
};

type Projected = { sx: number; sy: number; depth: number; visible: boolean };

const NEAR_PLANE = 0.5;
const SEGMENTS_AHEAD = 90;
const SEGMENTS_BEHIND = 4;
/** Decay constant for the camera-heading low-pass filter (per second). */
const CAM_HEADING_DECAY = 8;
/** Decay constant for the minimap-heading low-pass filter (per second). */
const MINIMAP_HEADING_DECAY = 6;
/** Decay constant for the per-ship bank smoother (per second). */
const SHIP_BANK_DECAY = 9;
// 1 full server tick (5 Hz → 200 ms) so we always have a "next" snapshot to
// interpolate toward. Increases visual latency by ~120 ms vs 10 Hz, which is
// the cost of fitting under the Cloudflare free tier.
const INTERP_DELAY_MS = 200;
const FOG_START = 60;
const FOG_END = 480;
const STAR_COUNT = 80;

/** Frame-rate-independent low-pass filter: returns the new value moving toward
 *  `target` with the given per-second decay constant `k`. */
const lpf = (current: number, target: number, k: number, dt: number): number => {
  const t = 1 - Math.exp(-k * Math.max(dt, 0));
  return current + (target - current) * t;
};

/** Same as lpf but for an angle, taking the shortest direction. */
const lpfAngle = (current: number, target: number, k: number, dt: number): number => {
  const delta = wrapAngle(target - current);
  const t = 1 - Math.exp(-k * Math.max(dt, 0));
  return current + delta * t;
};

const interpolate = (
  prev: ShipSnapshot | undefined,
  next: ShipSnapshot,
  t: number,
): { x: number; y: number; h: number; vx: number; vy: number; flags: number } => {
  if (!prev) return { x: next.x, y: next.y, h: next.h, vx: next.vx, vy: next.vy, flags: next.f };
  const a = Math.max(0, Math.min(1, t));
  return {
    x: prev.x + (next.x - prev.x) * a,
    y: prev.y + (next.y - prev.y) * a,
    h: lerpAngle(prev.h, next.h, a),
    vx: prev.vx + (next.vx - prev.vx) * a,
    vy: prev.vy + (next.vy - prev.vy) * a,
    flags: a > 0.5 ? next.f : prev.f,
  };
};

export const computeInterpolatedShips = (
  state: ClientState,
  nowMs: number,
): Map<string, { x: number; y: number; h: number; vx: number; vy: number; flags: number }> => {
  const out = new Map<string, { x: number; y: number; h: number; vx: number; vy: number; flags: number }>();
  if (state.snapshots.length === 0) return out;
  const newest = state.snapshots[state.snapshots.length - 1] as (typeof state.snapshots)[number];
  const renderTime = nowMs - INTERP_DELAY_MS;
  let prev: typeof newest | undefined;
  let next: typeof newest = newest;
  for (let i = state.snapshots.length - 1; i >= 0; i--) {
    const s = state.snapshots[i] as typeof newest;
    if (s.receivedAt <= renderTime) {
      prev = s;
      next = state.snapshots[Math.min(state.snapshots.length - 1, i + 1)] as typeof newest;
      break;
    }
  }
  if (!prev) {
    prev = state.snapshots[0] as typeof newest;
    next = newest;
  }
  const span = next.receivedAt - prev.receivedAt;
  const t = span > 0 ? (renderTime - prev.receivedAt) / span : 1;
  const prevById = new Map(prev.ships.map((s) => [s.id, s]));
  for (const ship of next.ships) {
    out.set(ship.id, interpolate(prevById.get(ship.id), ship, t));
  }
  return out;
};

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  maxAge: number;
  color: string;
  size: number;
};

type ShipMemory = {
  /** Last-known heading (for bank/turn-rate computation). */
  prevHeading: number;
  /** Smoothed bank angle (radians). */
  bank: number;
  /** Race time the ship's KO flag was first seen. null = alive. */
  koAt: number | null;
};

/** Cached pickup layout per track id. Computed lazily. */
const pickupCache = new Map<string, { layout: PickupSpec[]; positions: { x: number; y: number }[] }>();
const getPickupCache = (track: Track) => {
  let entry = pickupCache.get(track.id);
  if (!entry) {
    const layout = defaultPickups(track);
    const positions = layout.map((spec) => pickupWorldPos(track, spec));
    entry = { layout, positions };
    pickupCache.set(track.id, entry);
  }
  return entry;
};

/** Persistent render state: trails + camera heading + starfield + ship memories + particles. */
export class RenderState {
  private trails = new Map<string, { x: number; y: number }[]>();
  private smoothedHeading: number | null = null;
  private smoothedMinimapHeading: number | null = null;
  private stars: { x: number; y: number; r: number; tw: number }[] | null = null;
  private memories = new Map<string, ShipMemory>();
  private particles: Particle[] = [];
  private lastFrameMs: number | null = null;
  /** Performance.now() at which the local player triggered a spin attack. */
  private localSpinAt: number | null = null;
  /** Performance.now() at which the local player triggered a side attack + direction. */
  private localSideAt: { at: number; dir: -1 | 1 } | null = null;
  /** Highest `at` of pickup events already consumed for impact bursts. */
  private lastPickupBurstAt = 0;
  /** True when this RenderState has consumed a pickup event with this exact `at`. */
  shouldConsumePickupEvent(ev: PickupEvent): boolean {
    if (ev.at <= this.lastPickupBurstAt) return false;
    this.lastPickupBurstAt = ev.at;
    return true;
  }

  /** Highest `at` of hit events already consumed for impact bursts. */
  private lastHitBurstAt = 0;
  shouldConsumeHitEvent(ev: HitEvent): boolean {
    if (ev.at <= this.lastHitBurstAt) return false;
    this.lastHitBurstAt = ev.at;
    return true;
  }

  /** Mark a local spin attack starting at `nowMs` (client-side prediction). */
  triggerLocalSpin(nowMs: number): void {
    this.localSpinAt = nowMs;
  }

  /** Returns 0..1 progress of the local spin animation, or null if inactive. */
  localSpinProgress(nowMs: number, durationMs: number): number | null {
    if (this.localSpinAt === null) return null;
    const t = (nowMs - this.localSpinAt) / durationMs;
    if (t < 0 || t > 1) return null;
    return t;
  }

  /** Mark a local side-attack event with its direction (-1 left, +1 right). */
  triggerLocalSide(nowMs: number, dir: -1 | 1): void {
    this.localSideAt = { at: nowMs, dir };
  }

  /** Returns the active local side-attack record, or null if inactive. */
  localSideActive(nowMs: number, durationMs: number): { dir: -1 | 1; t: number } | null {
    if (!this.localSideAt) return null;
    const t = (nowMs - this.localSideAt.at) / durationMs;
    if (t < 0 || t > 1) return null;
    return { dir: this.localSideAt.dir, t };
  }

  updateTrails(ships: Map<string, { x: number; y: number }>) {
    for (const [id, pos] of ships) {
      const arr = this.trails.get(id) ?? [];
      arr.push({ x: pos.x, y: pos.y });
      if (arr.length > 8) arr.shift();
      this.trails.set(id, arr);
    }
    for (const id of [...this.trails.keys()]) {
      if (!ships.has(id)) this.trails.delete(id);
    }
  }

  trail(id: string): readonly { x: number; y: number }[] {
    return this.trails.get(id) ?? [];
  }

  smoothHeading(target: number, dt: number): number {
    if (this.smoothedHeading === null) {
      this.smoothedHeading = target;
      return target;
    }
    this.smoothedHeading = lpfAngle(this.smoothedHeading, target, CAM_HEADING_DECAY, dt);
    return this.smoothedHeading;
  }

  smoothMinimapHeading(target: number, dt: number): number {
    if (this.smoothedMinimapHeading === null) {
      this.smoothedMinimapHeading = target;
      return target;
    }
    this.smoothedMinimapHeading = lpfAngle(
      this.smoothedMinimapHeading,
      target,
      MINIMAP_HEADING_DECAY,
      dt,
    );
    return this.smoothedMinimapHeading;
  }

  /** Returns smoothed bank for the ship (radians) given its current heading. */
  updateShipMemory(
    id: string,
    heading: number,
    isKo: boolean,
    raceTime: number,
    dtSec: number,
  ): ShipMemory {
    let mem = this.memories.get(id);
    if (!mem) {
      mem = { prevHeading: heading, bank: 0, koAt: isKo ? raceTime : null };
      this.memories.set(id, mem);
      return mem;
    }
    const headingDelta = wrapAngle(heading - mem.prevHeading);
    const angVel = dtSec > 0 ? headingDelta / dtSec : 0;
    const target = Math.max(-0.45, Math.min(0.45, angVel * 0.18));
    mem.bank = lpf(mem.bank, target, SHIP_BANK_DECAY, dtSec);
    mem.prevHeading = heading;
    if (isKo && mem.koAt === null) mem.koAt = raceTime;
    if (!isKo) mem.koAt = null;
    return mem;
  }

  spawnBoostParticle(x: number, y: number, color: string): void {
    if (this.particles.length > 350) return; // hard cap to keep perf bounded
    this.particles.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 8,
      vy: (Math.random() - 0.5) * 8,
      age: 0,
      maxAge: 0.6 + Math.random() * 0.3,
      color,
      size: 2 + Math.random() * 2,
    });
  }

  /**
   * Spawn a burst of `count` particles around (x, y) with a per-attack feel.
   * - 'spin' -> radial outward fan, white/yellow tint
   * - 'side' -> directional sideways spray, cyan tint
   * - 'pickup' -> upward shimmer, kind-coloured
   */
  spawnImpactBurst(
    x: number,
    y: number,
    kind: 'spin' | 'side-left' | 'side-right' | 'pickup-boost' | 'pickup-heal' | 'pickup-mine',
    count: number,
  ): void {
    if (this.particles.length > 600) return;
    const colors: Record<typeof kind, string> = {
      spin: '#fff5b8',
      'side-left': '#3affe1',
      'side-right': '#3affe1',
      'pickup-boost': '#ffd23a',
      'pickup-heal': '#3eff8b',
      'pickup-mine': '#ff4040',
    } as const;
    for (let i = 0; i < count; i++) {
      let vx: number;
      let vy: number;
      if (kind === 'spin') {
        const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
        const sp = 30 + Math.random() * 30;
        vx = Math.cos(a) * sp;
        vy = Math.sin(a) * sp;
      } else if (kind === 'side-left' || kind === 'side-right') {
        const sign = kind === 'side-right' ? 1 : -1;
        vx = sign * (40 + Math.random() * 40);
        vy = (Math.random() - 0.5) * 30;
      } else {
        // upward shimmer for pickups
        vx = (Math.random() - 0.5) * 20;
        vy = -20 - Math.random() * 30;
      }
      this.particles.push({
        x,
        y,
        vx,
        vy,
        age: 0,
        maxAge: 0.45 + Math.random() * 0.4,
        color: colors[kind],
        size: 1.5 + Math.random() * 2,
      });
    }
  }

  stepParticles(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i] as Particle;
      p.age += dt;
      if (p.age >= p.maxAge) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.94;
      p.vy *= 0.94;
    }
  }

  particlesIter(): readonly Particle[] {
    return this.particles;
  }

  particleCount(): number {
    return this.particles.length;
  }

  /** Returns ms elapsed since last frame; first call returns 16. */
  consumeDt(nowMs: number): number {
    if (this.lastFrameMs === null) {
      this.lastFrameMs = nowMs;
      return 16;
    }
    const dt = nowMs - this.lastFrameMs;
    this.lastFrameMs = nowMs;
    return Math.min(100, dt);
  }

  ensureStars(width: number, horizonY: number): { x: number; y: number; r: number; tw: number }[] {
    if (this.stars && this.stars.length > 0) return this.stars;
    const arr: { x: number; y: number; r: number; tw: number }[] = [];
    let s = 1337;
    const rng = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    for (let i = 0; i < STAR_COUNT; i++) {
      arr.push({
        x: rng() * width,
        y: rng() * (horizonY - 4),
        r: 0.5 + rng() * 1.4,
        tw: rng() * Math.PI * 2,
      });
    }
    this.stars = arr;
    return arr;
  }

  reset(): void {
    this.trails.clear();
    this.smoothedHeading = null;
    this.stars = null;
    this.memories.clear();
    this.particles.length = 0;
    this.lastFrameMs = null;
    this.lastPickupBurstAt = 0;
    this.lastHitBurstAt = 0;
  }
}

export const setupCanvas = (canvas: HTMLCanvasElement): RenderContext | null => {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: rect.width, height: rect.height, dpr };
};

export type WorldPt = { x: number; y: number; z: number };

/**
 * Sutherland-Hodgman clip a closed polygon against the half-space z >= clipZ.
 * Vertices on the kept side are preserved; edges that cross the plane gain
 * a new vertex at the intersection (z = clipZ). Returns the clipped polygon
 * (which may be empty if the entire input lies behind the plane).
 */
export const clipPolygonAgainstZ = (
  poly: readonly WorldPt[],
  clipZ: number,
): WorldPt[] => {
  const out: WorldPt[] = [];
  if (poly.length === 0) return out;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as WorldPt;
    const b = poly[(i + 1) % poly.length] as WorldPt;
    const aIn = a.z >= clipZ;
    const bIn = b.z >= clipZ;
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const t = (clipZ - a.z) / (b.z - a.z);
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: clipZ,
      });
    }
  }
  return out;
};

/**
 * Cap the desired "ahead" segment count so the visible window never covers
 * more than the entire closed track once. Without this, short tracks
 * (oval = 48, peanut = 56) would wrap, producing self-overlapping geometry.
 */
export const segmentWindowAhead = (
  totalSegments: number,
  segmentsBehind: number,
  desiredAhead: number,
): number => Math.max(0, Math.min(desiredAhead, totalSegments - 1 - segmentsBehind));

export const project = (
  worldX: number,
  worldY: number,
  cam: CamPose,
  cfg: CamConfig,
  screenW: number,
): Projected => {
  const dx = worldX - cam.posX;
  const dy = worldY - cam.posY;
  const cosH = Math.cos(cam.heading);
  const sinH = Math.sin(cam.heading);
  const z = dx * cosH + dy * sinH;
  if (z <= NEAR_PLANE) return { sx: 0, sy: 0, depth: z, visible: false };
  const x = -dx * sinH + dy * cosH;
  const sx = screenW / 2 + (cfg.focal * x) / z;
  const sy = cfg.horizonY + (cfg.focal * cfg.height) / z;
  return { sx, sy, depth: z, visible: true };
};

/**
 * Project a world-space line segment, clipping it against the near plane.
 * Returns null if entirely behind the camera, otherwise both screen endpoints
 * with the closer corrected to z=NEAR.
 */
const projectSegment = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cam: CamPose,
  cfg: CamConfig,
  screenW: number,
): { a: Projected; b: Projected } | null => {
  const cosH = Math.cos(cam.heading);
  const sinH = Math.sin(cam.heading);
  const za = (ax - cam.posX) * cosH + (ay - cam.posY) * sinH;
  const zb = (bx - cam.posX) * cosH + (by - cam.posY) * sinH;
  let xa = ax;
  let ya = ay;
  let xb = bx;
  let yb = by;
  if (za <= NEAR_PLANE && zb <= NEAR_PLANE) return null;
  if (za <= NEAR_PLANE) {
    const t = (NEAR_PLANE - za) / (zb - za);
    xa = ax + (bx - ax) * t;
    ya = ay + (by - ay) * t;
  } else if (zb <= NEAR_PLANE) {
    const t = (NEAR_PLANE - zb) / (za - zb);
    xb = bx + (ax - bx) * t;
    yb = by + (ay - by) * t;
  }
  const a = project(xa, ya, cam, cfg, screenW);
  const b = project(xb, yb, cam, cfg, screenW);
  return { a, b };
};

/** Smoothly fade a value to zero between FOG_START and FOG_END. */
const fogAlpha = (depth: number): number => {
  if (depth <= FOG_START) return 1;
  if (depth >= FOG_END) return 0;
  return 1 - (depth - FOG_START) / (FOG_END - FOG_START);
};

const drawSky = (
  rc: RenderContext,
  rstate: RenderState,
  horizonY: number,
  cam: CamPose,
  nowMs: number,
): void => {
  const { ctx, width, height } = rc;
  // Sky gradient.
  const sky = ctx.createLinearGradient(0, 0, 0, horizonY);
  sky.addColorStop(0, '#0a0524');
  sky.addColorStop(0.7, '#1f0a44');
  sky.addColorStop(1, '#3a1758');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, horizonY);

  // Stars (parallax: scroll horizontally with camera heading).
  const stars = rstate.ensureStars(width, horizonY);
  const headingShift = (cam.heading * width) / Math.PI;
  for (let i = 0; i < stars.length; i++) {
    const star = stars[i] as (typeof stars)[number];
    const sx = ((star.x - headingShift) % width + width) % width;
    const twinkle = 0.5 + 0.5 * Math.sin(nowMs * 0.003 + star.tw);
    ctx.fillStyle = `rgba(255, 255, 255, ${0.25 + twinkle * 0.5})`;
    ctx.beginPath();
    ctx.arc(sx, star.y, star.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Background mountains: 2 parallax layers — far slow, near fast — both keyed
  // off camera heading so panning the camera shifts them at different rates.
  // Far layer: deep purple, scrolls slowly.
  drawSkylineLayer(ctx, width, horizonY, headingShift * 0.18, 1717, {
    fill: 'rgba(40, 14, 70, 0.85)',
    minH: 18,
    maxH: 60,
    bandTop: horizonY - 60,
  });
  // Near layer: brighter magenta, scrolls faster — sits in front of the far
  // layer at the horizon.
  drawSkylineLayer(ctx, width, horizonY, headingShift * 0.45, 4242, {
    fill: 'rgba(80, 28, 110, 0.88)',
    minH: 6,
    maxH: 38,
    bandTop: horizonY - 38,
  });

  // Horizon glow line.
  const horizonGlow = ctx.createLinearGradient(0, horizonY - 6, 0, horizonY + 6);
  horizonGlow.addColorStop(0, 'rgba(255, 58, 209, 0)');
  horizonGlow.addColorStop(0.5, 'rgba(255, 58, 209, 0.85)');
  horizonGlow.addColorStop(1, 'rgba(255, 58, 209, 0)');
  ctx.fillStyle = horizonGlow;
  ctx.fillRect(0, horizonY - 6, width, 12);

  // Ground gradient below horizon.
  const ground = ctx.createLinearGradient(0, horizonY, 0, height);
  ground.addColorStop(0, '#0c0530');
  ground.addColorStop(0.4, '#080224');
  ground.addColorStop(1, '#03000d');
  ctx.fillStyle = ground;
  ctx.fillRect(0, horizonY, width, height - horizonY);
};

/**
 * Draw a parallax skyline strip with deterministic jagged pillars. The pattern
 * tiles horizontally and shifts by `scroll` pixels so different layers can move
 * at different rates relative to the camera heading.
 */
const drawSkylineLayer = (
  ctx: CanvasRenderingContext2D,
  width: number,
  horizonY: number,
  scroll: number,
  seed: number,
  opts: { fill: string; minH: number; maxH: number; bandTop: number },
): void => {
  let s = seed;
  const rng = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  // Build one tile of width = ~width then draw it twice for seamless wrap.
  type Pillar = { w: number; h: number };
  const pillars: Pillar[] = [];
  let acc = 0;
  while (acc < width * 1.4) {
    const w = 18 + rng() * 40;
    const h = opts.minH + rng() * (opts.maxH - opts.minH);
    pillars.push({ w, h });
    acc += w;
  }
  const tileW = acc;
  const offset = ((scroll % tileW) + tileW) % tileW;
  ctx.fillStyle = opts.fill;
  ctx.beginPath();
  ctx.moveTo(-offset, horizonY);
  let x = -offset;
  // Repeat the tile twice so the pattern always covers width.
  for (let rep = 0; rep < 2; rep++) {
    for (const p of pillars) {
      ctx.lineTo(x, horizonY - p.h);
      ctx.lineTo(x + p.w, horizonY - p.h);
      x += p.w;
      if (x > width + offset) break;
    }
    if (x > width + offset) break;
  }
  ctx.lineTo(x, horizonY);
  ctx.closePath();
  ctx.fill();
  void opts.bandTop; // reserved for potential future band-clipping
};

const drawTrack = (
  rc: RenderContext,
  track: Track,
  cam: CamPose,
  cfg: CamConfig,
  centerSegIdx: number,
): void => {
  const { ctx, width } = rc;
  const N = track.centerline.length;

  // Sample both edges of each segment in world space across the visible window.
  // Tessellate each segment into multiple sub-points so curves stay smooth and
  // the near-plane clip produces a tight, gap-free polygon.
  const SUBS = 3;
  type EdgeSample = { x: number; y: number; z: number; idx: number; subT: number };
  const cosH = Math.cos(cam.heading);
  const sinH = Math.sin(cam.heading);
  const camZ = (x: number, y: number): number =>
    (x - cam.posX) * cosH + (y - cam.posY) * sinH;

  // Cap the visible window so we never render the same segment twice (the
  // track is a closed loop). For tracks shorter than SEGMENTS_AHEAD this would
  // otherwise build a self-overlapping polygon and the per-segment decorations
  // would draw lines that straddle the near plane on the far side, producing
  // huge off-screen projections.
  const aheadMax = segmentWindowAhead(N, SEGMENTS_BEHIND, SEGMENTS_AHEAD);
  const leftPts: EdgeSample[] = [];
  const rightPts: EdgeSample[] = [];
  for (let off = -SEGMENTS_BEHIND; off <= aheadMax; off++) {
    const idx = ((centerSegIdx + off) % N + N) % N;
    const lastSeg = off === aheadMax;
    const subCount = lastSeg ? SUBS + 1 : SUBS;
    for (let s = 0; s < subCount; s++) {
      const t = s / SUBS;
      const pl = edgePoint(track, idx, t, 1);
      const pr = edgePoint(track, idx, t, -1);
      leftPts.push({ x: pl.x, y: pl.y, z: camZ(pl.x, pl.y), idx, subT: t });
      rightPts.push({ x: pr.x, y: pr.y, z: camZ(pr.x, pr.y), idx, subT: t });
    }
  }

  // Build closed world-space polygon (left forward, right backward) and clip
  // it against the near plane. This is the only correct way to keep the
  // surface visible right up to the camera — simply skipping ribs whose
  // corner crosses the near plane would leave a hole in front of the player.
  // We use clipZ slightly above NEAR_PLANE so projected clip intersections
  // remain marked visible by `project()` (which gates on `z > NEAR_PLANE`).
  const CLIP_Z = NEAR_PLANE + 0.01;
  const poly: WorldPt[] = [];
  for (const p of leftPts) poly.push({ x: p.x, y: p.y, z: p.z });
  for (let i = rightPts.length - 1; i >= 0; i--) {
    const p = rightPts[i] as EdgeSample;
    poly.push({ x: p.x, y: p.y, z: p.z });
  }
  const clipped = clipPolygonAgainstZ(poly, CLIP_Z);
  if (clipped.length < 3) return;

  ctx.fillStyle = '#2c1a5a';
  ctx.beginPath();
  for (let i = 0; i < clipped.length; i++) {
    const p = clipped[i] as WorldPt;
    const proj = project(p.x, p.y, cam, cfg, width);
    if (i === 0) ctx.moveTo(proj.sx, proj.sy);
    else ctx.lineTo(proj.sx, proj.sy);
  }
  ctx.closePath();
  ctx.fill();

  // Per-rib decorations (alt shading, edge stripes, centre dash). Each is
  // emitted segment-by-segment with proper near-plane clipping so they line
  // up perfectly with the surface boundary.

  // Per-segment decorations need a comfortable safety margin from the near
  // plane: at z very close to NEAR_PLANE the projection diverges (sx → ±∞),
  // which would draw decorative lines off to infinity. The base surface
  // polygon (clipped via Sutherland-Hodgman) already covers everything from
  // the camera up to here, so this margin is invisible.
  const DECOR_MIN_Z = 1.5;

  // Alt rib shading — every other source segment.
  for (let i = 0; i < leftPts.length - 1; i++) {
    const al = leftPts[i] as EdgeSample;
    const bl = leftPts[i + 1] as EdgeSample;
    if (al.idx !== bl.idx) continue;
    if ((al.idx & 1) !== 0) continue;
    const ar = rightPts[i] as EdgeSample;
    const br = rightPts[i + 1] as EdgeSample;
    if (al.z < DECOR_MIN_Z || bl.z < DECOR_MIN_Z || ar.z < DECOR_MIN_Z || br.z < DECOR_MIN_Z)
      continue;
    const depth = (al.z + bl.z + ar.z + br.z) / 4;
    const fa = fogAlpha(depth);
    if (fa <= 0.02) continue;
    const pAL = project(al.x, al.y, cam, cfg, width);
    const pBL = project(bl.x, bl.y, cam, cfg, width);
    const pBR = project(br.x, br.y, cam, cfg, width);
    const pAR = project(ar.x, ar.y, cam, cfg, width);
    ctx.fillStyle = `rgba(54, 32, 110, ${fa * 0.55})`;
    ctx.beginPath();
    ctx.moveTo(pAL.sx, pAL.sy);
    ctx.lineTo(pBL.sx, pBL.sy);
    ctx.lineTo(pBR.sx, pBR.sy);
    ctx.lineTo(pAR.sx, pAR.sy);
    ctx.closePath();
    ctx.fill();
  }

  // Edge stripes per side.
  for (const side of [-1, 1] as const) {
    const color = side === -1 ? 'rgba(255, 58, 209,' : 'rgba(58, 255, 225,';
    const pts = side === -1 ? rightPts : leftPts;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i] as EdgeSample;
      const b = pts[i + 1] as EdgeSample;
      if (a.z < DECOR_MIN_Z || b.z < DECOR_MIN_Z) continue;
      const depth = (a.z + b.z) / 2;
      const fa = fogAlpha(depth);
      if (fa <= 0.02) continue;
      const pA = project(a.x, a.y, cam, cfg, width);
      const pB = project(b.x, b.y, cam, cfg, width);
      const edgeAlpha = fa * Math.max(0.35, 1 - depth / 220);
      ctx.lineWidth = Math.max(1, 3 - depth / 80);
      ctx.strokeStyle = `${color} ${edgeAlpha})`;
      ctx.beginPath();
      ctx.moveTo(pA.sx, pA.sy);
      ctx.lineTo(pB.sx, pB.sy);
      ctx.stroke();
    }
  }

  // Centre dashed lane stripe — every other source segment.
  for (let i = 0; i < leftPts.length - 1; i++) {
    const al = leftPts[i] as EdgeSample;
    const bl = leftPts[i + 1] as EdgeSample;
    if (al.idx !== bl.idx) continue;
    if ((al.idx & 1) !== 0) continue;
    const ar = rightPts[i] as EdgeSample;
    const br = rightPts[i + 1] as EdgeSample;
    if (al.z < DECOR_MIN_Z || bl.z < DECOR_MIN_Z || ar.z < DECOR_MIN_Z || br.z < DECOR_MIN_Z)
      continue;
    const m1x = (al.x + ar.x) / 2;
    const m1y = (al.y + ar.y) / 2;
    const m2x = (bl.x + br.x) / 2;
    const m2y = (bl.y + br.y) / 2;
    const depth = (al.z + bl.z) / 2;
    const fa = fogAlpha(depth);
    if (fa <= 0.02) continue;
    const pA = project(m1x, m1y, cam, cfg, width);
    const pB = project(m2x, m2y, cam, cfg, width);
    ctx.strokeStyle = `rgba(255, 255, 255, ${fa * Math.max(0.3, 1 - depth / 220) * 0.5})`;
    ctx.lineWidth = Math.max(1, 2.5 - depth / 100);
    ctx.beginPath();
    ctx.moveTo(pA.sx, pA.sy);
    ctx.lineTo(pB.sx, pB.sy);
    ctx.stroke();
  }

  // Start/finish line (drawn after surface so it sits on top).
  const cpIdx = track.checkpoints[0] as number;
  const a = track.centerline[cpIdx] as { x: number; y: number };
  const b = track.centerline[(cpIdx + 1) % N] as { x: number; y: number };
  const tx = b.x - a.x;
  const ty = b.y - a.y;
  const len = Math.hypot(tx, ty) || 1;
  const nx = -ty / len;
  const ny = tx / len;
  const sf = projectSegment(
    a.x + nx * track.halfWidth,
    a.y + ny * track.halfWidth,
    a.x - nx * track.halfWidth,
    a.y - ny * track.halfWidth,
    cam,
    cfg,
    width,
  );
  if (sf) {
    const depth = (sf.a.depth + sf.b.depth) / 2;
    const fa = fogAlpha(depth);
    ctx.strokeStyle = `rgba(255, 255, 255, ${fa})`;
    ctx.lineWidth = Math.max(2, 6 - depth / 50);
    ctx.beginPath();
    ctx.moveTo(sf.a.sx, sf.a.sy);
    ctx.lineTo(sf.b.sx, sf.b.sy);
    ctx.stroke();
  }
};

const KO_ANIM_S = 1.6;

/**
 * Per-class body shape multipliers. Speed = thinner+longer, tank = wider+
 * shorter, balanced = the original 1.0 baseline.
 */
const CLASS_BODY = {
  speed: { wMul: 0.85, lMul: 1.15 },
  tank: { wMul: 1.18, lMul: 0.92 },
  balanced: { wMul: 1, lMul: 1 },
} as const;

const drawShip = (
  rc: RenderContext,
  cam: CamPose,
  cfg: CamConfig,
  ship: { x: number; y: number; h: number; flags: number },
  player: PlayerInfoMsg | undefined,
  isMe: boolean,
  nowMs: number,
  bank: number,
  koElapsed: number,
): void => {
  const { ctx, width } = rc;
  const ko = (ship.flags & FLAG_KO) !== 0;
  const sky = (ship.flags & FLAG_SKYWAY) !== 0;
  const boost = (ship.flags & FLAG_FREE_BOOST) !== 0;
  const color = player?.color ?? '#888';

  const pivot = project(ship.x, ship.y, cam, cfg, width);
  if (!pivot.visible) return;

  const fogA = fogAlpha(pivot.depth);
  if (fogA <= 0.02) return;

  // KO fade-out: ship shrinks + spins + fades over KO_ANIM_S.
  let koProgress = 0;
  if (ko && koElapsed >= 0) {
    koProgress = Math.min(1, koElapsed / KO_ANIM_S);
    if (koProgress >= 1) return; // gone
  }

  const baseSize = isMe ? 22 : 17;
  const rawSize = Math.min(baseSize, (cfg.focal * 2.4) / pivot.depth);
  // When the projected size dips below ~4 px the ship looks like a flickery
  // dot — fade the alpha proportionally so it disappears smoothly rather than
  // aliasing in/out at the horizon.
  const sizeFade = Math.max(0, Math.min(1, (rawSize - 1.5) / 4));
  let size = Math.max(2.5, rawSize);
  if (ko) size *= 1 - koProgress * 0.6;
  const fa = fogA * sizeFade * (1 - koProgress);
  if (fa <= 0.02) return;
  const relHeading = wrapAngle(ship.h - cam.heading) + (ko ? koElapsed * 6 : 0);

  // Ground shadow under the ship (an oval).
  ctx.save();
  ctx.translate(pivot.sx, pivot.sy + size * 0.15);
  ctx.fillStyle = `rgba(0, 0, 0, ${0.45 * fa})`;
  ctx.beginPath();
  ctx.ellipse(0, size * 0.1, size * 0.9, size * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(pivot.sx, pivot.sy);
  ctx.rotate(relHeading);
  // Bank: slight horizontal squash that mimics rolling into a turn.
  const bankScaleX = 1 - Math.abs(bank) * 0.5;
  ctx.transform(bankScaleX, 0, bank * 0.4, 1, 0, 0);
  ctx.globalAlpha = fa;

  if (sky) {
    ctx.shadowColor = '#3affe1';
    ctx.shadowBlur = 20;
  } else if (boost && !ko) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
  }

  // Body: arrow with a darker rear and a cockpit highlight. Per-class
  // shape mul makes speed ships thin/long and tanks chunky/short.
  const cls = (player?.cls ?? 'balanced') as keyof typeof CLASS_BODY;
  const shape = CLASS_BODY[cls] ?? CLASS_BODY.balanced;
  const w = size * shape.wMul;
  const l = size * shape.lMul;
  ctx.fillStyle = ko ? '#3a3a3a' : color;
  ctx.beginPath();
  ctx.moveTo(0, -l * 0.95);
  ctx.lineTo(w * 0.75, l * 0.65);
  ctx.lineTo(w * 0.32, l * 0.4);
  ctx.lineTo(0, l * 0.55);
  ctx.lineTo(-w * 0.32, l * 0.4);
  ctx.lineTo(-w * 0.75, l * 0.65);
  ctx.closePath();
  ctx.fill();

  // Cockpit highlight (lighter triangle near nose).
  if (!ko) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.beginPath();
    ctx.moveTo(0, -l * 0.55);
    ctx.lineTo(w * 0.18, -l * 0.05);
    ctx.lineTo(-w * 0.18, -l * 0.05);
    ctx.closePath();
    ctx.fill();
  }

  // Player outline.
  if (isMe && !ko) {
    ctx.lineWidth = Math.max(1, size * 0.13);
    ctx.strokeStyle = '#fff';
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(0, -l * 0.95);
    ctx.lineTo(w * 0.75, l * 0.65);
    ctx.lineTo(0, l * 0.55);
    ctx.lineTo(-w * 0.75, l * 0.65);
    ctx.closePath();
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  // Boost flame (animated).
  if (boost && !ko) {
    const flick = 0.7 + 0.3 * Math.sin(nowMs * 0.05);
    ctx.fillStyle = `rgba(255, 210, 58, ${0.5 * fa})`;
    ctx.beginPath();
    ctx.moveTo(-size * 0.35, size * 0.6);
    ctx.lineTo(size * 0.35, size * 0.6);
    ctx.lineTo(0, size * (1.4 + flick * 0.5));
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = `rgba(255, 255, 255, ${0.6 * fa})`;
    ctx.beginPath();
    ctx.moveTo(-size * 0.18, size * 0.6);
    ctx.lineTo(size * 0.18, size * 0.6);
    ctx.lineTo(0, size * (1.0 + flick * 0.3));
    ctx.closePath();
    ctx.fill();
  }
  if (sky) {
    ctx.strokeStyle = `rgba(58, 255, 225, ${0.7 * fa})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, size * 1.3 + Math.sin(nowMs * 0.01) * 2, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // Name label for human players, drawn in screen space (no rotation / bank)
  // so it stays readable. Skipped for bots — there'd be ~95 of them on a full
  // grid and the screen would be unreadable. Skipped for the local player too
  // since you already know where you are.
  if (player && !player.bot && !isMe && !ko) {
    const nameAlpha = fa * 0.95;
    if (nameAlpha > 0.05) {
      ctx.save();
      ctx.globalAlpha = nameAlpha;
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.fillStyle = player.color;
      const labelY = pivot.sy - size * 1.6;
      ctx.strokeText(player.name, pivot.sx, labelY);
      ctx.fillText(player.name, pivot.sx, labelY);
      ctx.restore();
    }
  }
};

export const renderFrame = (
  rc: RenderContext,
  state: ClientState,
  rstate: RenderState,
  nowMs: number,
): void => {
  const { width, height } = rc;
  const track = findTrack(state.trackId);
  const ships = computeInterpolatedShips(state, nowMs);
  rstate.updateTrails(new Map([...ships.entries()].map(([id, s]) => [id, { x: s.x, y: s.y }])));

  const localShip = state.myId ? ships.get(state.myId) : undefined;
  const localKo = localShip ? (localShip.flags & FLAG_KO) !== 0 : false;
  // When the local player is KO'd, hasn't been placed yet, or the death cam
  // is active, switch the camera to the spectator target (death cam picks
  // the attacker; otherwise the alive leader by arc length).
  let me = localShip;
  if (!me || localKo) {
    const targetId = spectatorTargetId(state, nowMs);
    if (targetId) me = ships.get(targetId);
  }
  if (!me) {
    rstate.consumeDt(nowMs);
    drawOverview(rc, track, state, ships);
    return;
  }

  // Per-frame dt up front so all smoothing is dt-aware.
  const dtSec = rstate.consumeDt(nowMs) / 1000;
  const raceTime = state.snapshots[state.snapshots.length - 1]?.time ?? 0;

  const targetHeading = me.h;
  const heading = rstate.smoothHeading(targetHeading, dtSec);
  const cosH = Math.cos(heading);
  const sinH = Math.sin(heading);

  // Speed factor used to drive the speed-feel effects.
  const REF_SPEED = 280;
  const speedNorm = Math.max(0, Math.min(1, Math.hypot(me.vx, me.vy) / REF_SPEED));

  // Subtle vertical bob synced to speed: at full speed the camera dips
  // ~1.5px each cycle, which is enough to register as motion without
  // smearing the rest of the frame.
  const bob = Math.sin(nowMs * 0.022) * speedNorm * 1.5;

  const cfg: CamConfig = {
    // Camera drops slightly closer to the ground at high speed (more dramatic
    // perspective on the track surface rushing forward).
    height: 14 * (1 - speedNorm * 0.22),
    // Pull the camera in a touch when going fast — the player feels the ship
    // gain on the screen rather than sit at a fixed distance.
    distBehind: 28 * (1 - speedNorm * 0.18),
    focal: Math.max(280, Math.min(width, height) * 0.5),
    // Horizon dips slightly with speed + bob, exaggerating forward motion.
    horizonY: height * 0.42 + speedNorm * 14 + bob,
  };
  const cam: CamPose = {
    posX: me.x - cosH * cfg.distBehind,
    posY: me.y - sinH * cfg.distBehind,
    heading,
  };

  drawSky(rc, rstate, cfg.horizonY, cam, nowMs);
  const closest = closestOnTrack(track, { x: me.x, y: me.y });
  drawTrack(rc, track, cam, cfg, closest.segIdx);

  // Pickups (active mask comes from the latest snapshot).
  const lastSnap = state.snapshots[state.snapshots.length - 1];
  const activeMask = lastSnap?.pk ?? 0;
  drawPickups(rc, track, activeMask, cam, cfg, nowMs);

  // Spawn pickup-event impact bursts at the consumed pad's world position.
  for (const ev of state.pickupEvents) {
    if (!rstate.shouldConsumePickupEvent(ev)) continue;
    const cache = getPickupCache(track);
    const p = cache.positions[ev.idx];
    if (!p) continue;
    const kind: 'pickup-boost' | 'pickup-heal' | 'pickup-mine' =
      ev.kind === 'boost' ? 'pickup-boost' : ev.kind === 'heal' ? 'pickup-heal' : 'pickup-mine';
    rstate.spawnImpactBurst(p.x, p.y, kind, 12);
  }

  // Spawn server-authoritative hit-event impact bursts at the victim's
  // world position. Filtered to spin / side hits (others not emitted yet).
  for (const ev of state.hitEvents) {
    if (!rstate.shouldConsumeHitEvent(ev)) continue;
    if (ev.kind === 'spin') {
      rstate.spawnImpactBurst(ev.x, ev.y, 'spin', 8);
    } else if (ev.kind === 'side-left') {
      rstate.spawnImpactBurst(ev.x, ev.y, 'side-left', 6);
    } else if (ev.kind === 'side-right') {
      rstate.spawnImpactBurst(ev.x, ev.y, 'side-right', 6);
    }
  }

  // Update ship memories once + spawn boost particles for boosting ships.
  const memMap = new Map<string, ReturnType<typeof rstate.updateShipMemory>>();
  for (const [id, s] of ships) {
    const isKo = (s.flags & FLAG_KO) !== 0;
    memMap.set(id, rstate.updateShipMemory(id, s.h, isKo, raceTime, dtSec));
    if (!isKo && (s.flags & FLAG_FREE_BOOST) !== 0) {
      const back = 4;
      const px = s.x - Math.cos(s.h) * back;
      const py = s.y - Math.sin(s.h) * back;
      const color = state.players[id]?.color ?? '#ffd23a';
      rstate.spawnBoostParticle(px, py, color);
    }
  }
  rstate.stepParticles(dtSec);

  drawTrails(rc, rstate, ships, state, cam, cfg);

  drawParticles(rc, rstate, cam, cfg);

  // Local spin attack: rotate the player's ship a full turn over the spin
  // duration so the strike actually reads as a spin rather than a flash.
  const SPIN_VIS_MS = 420;
  const SIDE_VIS_MS = 320;
  const localSpinT = rstate.localSpinProgress(nowMs, SPIN_VIS_MS);
  const localSpinAngle = localSpinT !== null ? localSpinT * Math.PI * 2 : 0;
  // Spawn one burst at the spin start (t small) and at side-attack start.
  if (localSpinT !== null && localSpinT < 0.05) {
    rstate.spawnImpactBurst(me.x, me.y, 'spin', 14);
  }
  const sideActive = rstate.localSideActive(nowMs, SIDE_VIS_MS);
  if (sideActive && sideActive.t < 0.08) {
    // Offset the burst to the attacked side (perpendicular to heading).
    const px = me.x - Math.sin(me.h) * sideActive.dir * 6;
    const py = me.y + Math.cos(me.h) * sideActive.dir * 6;
    rstate.spawnImpactBurst(
      px,
      py,
      sideActive.dir === -1 ? 'side-left' : 'side-right',
      10,
    );
  }

  const projected = [...ships.entries()].map(([id, s]) => {
    const p = project(s.x, s.y, cam, cfg, width);
    return { id, ship: s, depth: p.depth };
  });
  projected.sort((a, b) => b.depth - a.depth);
  for (const { id, ship } of projected) {
    const mem = memMap.get(id);
    if (!mem) continue;
    const koElapsed = mem.koAt !== null ? raceTime - mem.koAt : -1;
    const isMe = id === state.myId;
    const drawn = isMe && localSpinT !== null ? { ...ship, h: ship.h + localSpinAngle } : ship;
    // While spinning, suppress the bank shear so the rotation reads as a clean
    // pivot around the ship's pivot rather than a wobbly skid.
    const bank = isMe && localSpinT !== null ? 0 : mem.bank;
    drawShip(rc, cam, cfg, drawn, state.players[id], isMe, nowMs, bank, koElapsed);
  }

  drawSpeedFx(rc, cfg.horizonY, speedNorm, nowMs);
};

const drawSpeedFx = (
  rc: RenderContext,
  horizonY: number,
  speedNorm: number,
  nowMs: number,
): void => {
  const { ctx, width, height } = rc;

  // Vignette: edges darken with speed, gives a tunnel-vision feel.
  if (speedNorm > 0.05) {
    const vGrad = ctx.createRadialGradient(
      width / 2,
      horizonY + (height - horizonY) * 0.25,
      Math.min(width, height) * 0.18,
      width / 2,
      horizonY + (height - horizonY) * 0.25,
      Math.max(width, height) * 0.65,
    );
    vGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vGrad.addColorStop(1, `rgba(0, 0, 0, ${0.35 * speedNorm})`);
    ctx.fillStyle = vGrad;
    ctx.fillRect(0, 0, width, height);
  }

  void nowMs;
  // The radial "speed streaks" overlay was removed: regenerating ~30 lines
  // per frame at random angles produced obvious flicker. The vignette above
  // already conveys the speed feel; we leave it as the sole at-speed cue.
};

/**
 * Pickup pads: draw all pads of the same kind in one stylesheet pass to
 * minimise state changes. No shadowBlur — at ~14 pads/track that was 14
 * per-frame gaussian blurs which is wasteful when most pads are off-screen
 * or behind the camera.
 */
const drawPickups = (
  rc: RenderContext,
  track: Track,
  activeMask: number,
  cam: CamPose,
  cfg: CamConfig,
  nowMs: number,
): void => {
  const { ctx, width } = rc;
  const cache = getPickupCache(track);
  const pulse = 0.85 + 0.15 * Math.sin(nowMs * 0.006);

  // First pass: project visible pads once.
  type Drawn = { sx: number; sy: number; r: number; fa: number; kind: 'boost' | 'heal' | 'mine' };
  const drawn: Drawn[] = [];
  for (let i = 0; i < cache.layout.length; i++) {
    if ((activeMask & (1 << i)) === 0) continue;
    const spec = cache.layout[i] as PickupSpec;
    const pos = cache.positions[i] as { x: number; y: number };
    const proj = project(pos.x, pos.y, cam, cfg, width);
    if (!proj.visible) continue;
    const fa = fogAlpha(proj.depth);
    if (fa <= 0.04) continue;
    const r = Math.max(2.5, (cfg.focal * 6) / proj.depth) * pulse;
    drawn.push({ sx: proj.sx, sy: proj.sy, r, fa, kind: spec.kind });
  }
  if (drawn.length === 0) return;

  // Second pass: bucket by kind and stroke each bucket as a single path.
  const colors = { boost: '#ffd23a', heal: '#3eff8b', mine: '#ff4040' } as const;
  for (const kind of ['boost', 'heal', 'mine'] as const) {
    const sub = drawn.filter((d) => d.kind === kind);
    if (sub.length === 0) continue;
    ctx.fillStyle = colors[kind];
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    for (const d of sub) {
      ctx.moveTo(d.sx + d.r, d.sy);
      ctx.arc(d.sx, d.sy, d.r, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  // Glyphs in a single pass.
  const glyphFor: Record<'boost' | 'heal' | 'mine', string> = {
    boost: '>',
    heal: '+',
    mine: 'x',
  };
  ctx.fillStyle = 'rgba(10, 5, 36, 0.9)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let lastFont = '';
  for (const d of drawn) {
    const font = `${Math.max(8, Math.round(d.r * 1.3))}px ui-sans-serif, system-ui`;
    if (font !== lastFont) {
      ctx.font = font;
      lastFont = font;
    }
    ctx.fillText(glyphFor[d.kind], d.sx, d.sy + 1);
  }
  ctx.globalAlpha = 1;
};

/**
 * Draw a fading neon trail behind every ship.
 *
 * Performance: trails are drawn as ONE path per ship (one beginPath + stroke
 * call) at constant width and a single pre-multiplied alpha. The previous
 * per-segment loop with `shadowBlur` was the dominant cost when 99 ships
 * cluster, because Canvas2D shadows are essentially a per-stroke gaussian
 * blur — multiplied by ~800 strokes/frame they tank the GPU. We cull trails
 * whose ship is far behind or far ahead of the camera, so when the cluster
 * sits behind us we pay almost nothing.
 */
const TRAIL_MAX_DEPTH = 220;
const drawTrails = (
  rc: RenderContext,
  rstate: RenderState,
  ships: Map<string, { x: number; y: number; flags: number }>,
  state: ClientState,
  cam: CamPose,
  cfg: CamConfig,
): void => {
  const { ctx, width } = rc;
  const cosH = Math.cos(cam.heading);
  const sinH = Math.sin(cam.heading);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2;
  for (const [id, s] of ships) {
    if ((s.flags & FLAG_KO) !== 0) continue;
    // Cheap depth cull on the ship's pivot — if the ship itself is behind the
    // camera or past the fog wall, its whole trail is invisible.
    const dx = s.x - cam.posX;
    const dy = s.y - cam.posY;
    const z = dx * cosH + dy * sinH;
    if (z <= NEAR_PLANE || z > TRAIL_MAX_DEPTH) continue;
    const trail = rstate.trail(id);
    if (trail.length < 2) continue;
    const color = state.players[id]?.color ?? '#888';
    // Single path: walk the trail forward, stroking what survives near-plane
    // and emitting fresh sub-paths around each behind-camera vertex. We skip
    // shadowBlur entirely — the alpha + neon colour read as glow on dark bg.
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < trail.length; i++) {
      const p = trail[i] as { x: number; y: number };
      const pz = (p.x - cam.posX) * cosH + (p.y - cam.posY) * sinH;
      if (pz <= NEAR_PLANE) {
        started = false;
        continue;
      }
      const proj = project(p.x, p.y, cam, cfg, width);
      if (!started) {
        ctx.moveTo(proj.sx, proj.sy);
        started = true;
      } else {
        ctx.lineTo(proj.sx, proj.sy);
      }
    }
    const fa = fogAlpha(z);
    ctx.globalAlpha = fa * 0.45;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
};

const drawParticles = (
  rc: RenderContext,
  rstate: RenderState,
  cam: CamPose,
  cfg: CamConfig,
): void => {
  const { ctx, width } = rc;
  for (const p of rstate.particlesIter()) {
    const proj = project(p.x, p.y, cam, cfg, width);
    if (!proj.visible) continue;
    const fa = fogAlpha(proj.depth);
    if (fa <= 0.02) continue;
    const lifeLeft = 1 - p.age / p.maxAge;
    const r = Math.max(0.5, (cfg.focal * p.size * 0.06) / proj.depth) * lifeLeft;
    ctx.fillStyle = p.color;
    ctx.globalAlpha = fa * lifeLeft * 0.7;
    ctx.beginPath();
    ctx.arc(proj.sx, proj.sy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
};

const drawOverview = (
  rc: RenderContext,
  track: Track,
  state: ClientState,
  ships: Map<string, { x: number; y: number }>,
): void => {
  const { ctx, width, height } = rc;
  ctx.fillStyle = '#06010f';
  ctx.fillRect(0, 0, width, height);
  const bounds = trackBounds(track);
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const cx = (bounds.maxX + bounds.minX) / 2;
  const cy = (bounds.maxY + bounds.minY) / 2;
  const zoom = Math.min(width / w, height / h) * 0.85;
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-cx, -cy);
  ctx.strokeStyle = '#15082a';
  ctx.lineWidth = track.halfWidth * 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < track.centerline.length; i++) {
    const p = track.centerline[i] as { x: number; y: number };
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.stroke();
  for (const [id, s] of ships) {
    ctx.fillStyle = state.players[id]?.color ?? '#888';
    ctx.beginPath();
    ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
};

export const renderMinimap = (
  ctx: CanvasRenderingContext2D,
  state: ClientState,
  rstate: RenderState,
  width: number,
  height: number,
  dtSec: number,
): void => {
  ctx.clearRect(0, 0, width, height);
  const track = findTrack(state.trackId);
  const last = state.snapshots[state.snapshots.length - 1];
  const me = last?.ships.find((s) => s.id === state.myId);
  // Find scaling so the whole track fits even after rotation: use the
  // diameter (max bound) so rotating doesn't cause clipping.
  const bounds = trackBounds(track);
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const cx = (bounds.maxX + bounds.minX) / 2;
  const cy = (bounds.maxY + bounds.minY) / 2;
  const diam = Math.hypot(w, h);
  const s = (Math.min(width, height) - 12) / diam;

  ctx.save();
  ctx.translate(width / 2, height / 2);
  if (me) {
    const target = -me.h - Math.PI / 2;
    const smoothed = rstate.smoothMinimapHeading(target, dtSec);
    ctx.rotate(smoothed);
  }
  // Track is drawn centred on the camera (player) when known, else on the
  // track centre.
  const focusX = me ? me.x : cx;
  const focusY = me ? me.y : cy;
  ctx.translate(-focusX * s, -focusY * s);

  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i <= track.centerline.length; i++) {
    const p = track.centerline[i % track.centerline.length] as { x: number; y: number };
    const xx = p.x * s;
    const yy = p.y * s;
    if (i === 0) ctx.moveTo(xx, yy);
    else ctx.lineTo(xx, yy);
  }
  ctx.stroke();
  if (last) {
    for (const ship of last.ships) {
      const isMe = ship.id === state.myId;
      const ko = (ship.f & FLAG_KO) !== 0;
      ctx.fillStyle = isMe
        ? '#fff'
        : ko
          ? 'rgba(120,120,120,0.5)'
          : state.players[ship.id]?.color ?? '#888';
      ctx.globalAlpha = ko ? 0.4 : 1;
      ctx.beginPath();
      ctx.arc(ship.x * s, ship.y * s, isMe ? 3 : 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();

  // Draw a fixed "player marker" arrow at the centre, above the rotated map.
  if (me) {
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(255, 58, 209, 0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4, 4);
    ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
};

const trackBounds = (track: Track): { minX: number; maxX: number; minY: number; maxY: number } => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of track.centerline) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = track.halfWidth + 8;
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
};
