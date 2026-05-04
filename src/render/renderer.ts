import type { ShipSnapshot } from '../../shared/protocol.ts';
import { FLAG_FREE_BOOST, FLAG_KO, FLAG_SKYWAY } from '../../shared/protocol.ts';
import type { Track } from '../../shared/track.ts';
import { closestOnTrack, edgePoint } from '../../shared/track.ts';
import { type ClientState } from '../state.ts';
import { findTrack } from '../../shared/track.ts';
import { type PlayerInfoMsg } from '../../shared/protocol.ts';
import { lerpAngle, wrapAngle } from '../../shared/vec2.ts';

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
const INTERP_DELAY_MS = 80;
const GRID_SIZE = 80;
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

const project = (
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

  // Distant skyline silhouette (a few jagged pillars near the horizon).
  ctx.fillStyle = 'rgba(60, 20, 88, 0.85)';
  let s = 4242;
  const rng = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  ctx.beginPath();
  ctx.moveTo(0, horizonY);
  let x = 0;
  while (x < width) {
    const w = 18 + rng() * 40;
    const h = 6 + rng() * 38;
    ctx.lineTo(x, horizonY - h);
    ctx.lineTo(x + w, horizonY - h);
    x += w;
  }
  ctx.lineTo(width, horizonY);
  ctx.closePath();
  ctx.fill();

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

/** Draw an infinite synthwave grid on the ground plane. */
const drawGrid = (rc: RenderContext, cam: CamPose, cfg: CamConfig): void => {
  const { ctx, width } = rc;
  ctx.lineWidth = 1;
  // World-axis-aligned grid lines around the camera.
  const px = cam.posX;
  const py = cam.posY;
  const baseX = Math.floor(px / GRID_SIZE) * GRID_SIZE;
  const baseY = Math.floor(py / GRID_SIZE) * GRID_SIZE;
  const span = 12;
  // Lines parallel to world Y axis (constant world X).
  for (let i = -span; i <= span; i++) {
    const wx = baseX + i * GRID_SIZE;
    const a = { x: wx, y: py - GRID_SIZE * span };
    const b = { x: wx, y: py + GRID_SIZE * span };
    const seg = projectSegment(a.x, a.y, b.x, b.y, cam, cfg, width);
    if (!seg) continue;
    const minDepth = Math.min(seg.a.depth, seg.b.depth);
    const alpha = fogAlpha(minDepth) * 0.6;
    if (alpha <= 0.01) continue;
    ctx.strokeStyle = `rgba(58, 255, 225, ${alpha * 0.4})`;
    ctx.beginPath();
    ctx.moveTo(seg.a.sx, seg.a.sy);
    ctx.lineTo(seg.b.sx, seg.b.sy);
    ctx.stroke();
  }
  // Lines parallel to world X axis (constant world Y).
  for (let i = -span; i <= span; i++) {
    const wy = baseY + i * GRID_SIZE;
    const a = { x: px - GRID_SIZE * span, y: wy };
    const b = { x: px + GRID_SIZE * span, y: wy };
    const seg = projectSegment(a.x, a.y, b.x, b.y, cam, cfg, width);
    if (!seg) continue;
    const minDepth = Math.min(seg.a.depth, seg.b.depth);
    const alpha = fogAlpha(minDepth) * 0.6;
    if (alpha <= 0.01) continue;
    ctx.strokeStyle = `rgba(255, 58, 209, ${alpha * 0.4})`;
    ctx.beginPath();
    ctx.moveTo(seg.a.sx, seg.a.sy);
    ctx.lineTo(seg.b.sx, seg.b.sy);
    ctx.stroke();
  }
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
  const aheadMax = Math.min(SEGMENTS_AHEAD, N - 1 - SEGMENTS_BEHIND);
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

  // Build closed world-space polygon (left forward, right backward), clip it
  // against the near plane (Sutherland-Hodgman), then project. This is the
  // only correct way to keep the surface visible right up to the camera —
  // simply skipping ribs whose corner crosses the near plane would leave a
  // hole in front of the player.
  type WorldPt = { x: number; y: number; z: number };
  const poly: WorldPt[] = [];
  for (const p of leftPts) poly.push({ x: p.x, y: p.y, z: p.z });
  for (let i = rightPts.length - 1; i >= 0; i--) {
    const p = rightPts[i] as EdgeSample;
    poly.push({ x: p.x, y: p.y, z: p.z });
  }
  // Slight epsilon above NEAR_PLANE so projected clip intersections remain
  // marked visible by `project()` (which gates on `z > NEAR_PLANE`).
  const CLIP_Z = NEAR_PLANE + 0.01;
  const clipped: WorldPt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as WorldPt;
    const b = poly[(i + 1) % poly.length] as WorldPt;
    const aIn = a.z >= CLIP_Z;
    const bIn = b.z >= CLIP_Z;
    if (aIn) clipped.push(a);
    if (aIn !== bIn) {
      const t = (CLIP_Z - a.z) / (b.z - a.z);
      clipped.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: CLIP_Z,
      });
    }
  }
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

  // Body: arrow with a darker rear and a cockpit highlight.
  ctx.fillStyle = ko ? '#3a3a3a' : color;
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.95);
  ctx.lineTo(size * 0.75, size * 0.65);
  ctx.lineTo(size * 0.32, size * 0.4);
  ctx.lineTo(0, size * 0.55);
  ctx.lineTo(-size * 0.32, size * 0.4);
  ctx.lineTo(-size * 0.75, size * 0.65);
  ctx.closePath();
  ctx.fill();

  // Cockpit highlight (lighter triangle near nose).
  if (!ko) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.55);
    ctx.lineTo(size * 0.18, -size * 0.05);
    ctx.lineTo(-size * 0.18, -size * 0.05);
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
    ctx.moveTo(0, -size * 0.95);
    ctx.lineTo(size * 0.75, size * 0.65);
    ctx.lineTo(0, size * 0.55);
    ctx.lineTo(-size * 0.75, size * 0.65);
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

  const me = state.myId ? ships.get(state.myId) : undefined;
  if (!me) {
    // Reset the per-frame timer so the first in-race frame doesn't see a giant dt.
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
  drawGrid(rc, cam, cfg);
  const closest = closestOnTrack(track, { x: me.x, y: me.y });
  drawTrack(rc, track, cam, cfg, closest.segIdx);

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

  drawParticles(rc, rstate, cam, cfg);

  // Local spin attack: rotate the player's ship a full turn over the spin
  // duration so the strike actually reads as a spin rather than a flash.
  const SPIN_VIS_MS = 420;
  const localSpinT = rstate.localSpinProgress(nowMs, SPIN_VIS_MS);
  const localSpinAngle = localSpinT !== null ? localSpinT * Math.PI * 2 : 0;

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

  // Radial speed streaks emanating from the vanishing point. We use a low
  // streak count + per-frame jitter (rather than a persistent particle
  // system) because the eye reads the radial motion, not individual lines.
  if (speedNorm < 0.18) return;
  const cx = width / 2;
  const cy = horizonY;
  const count = Math.floor(14 + speedNorm * 26);
  ctx.strokeStyle = `rgba(255, 255, 255, ${0.18 + speedNorm * 0.32})`;
  ctx.lineWidth = 1.2;
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    // Pseudo-random angle, tied to streak index, slowly rotating.
    const a = (i * 2.399963 + nowMs * 0.0008 * (0.6 + speedNorm)) % (Math.PI * 2);
    const phase = (nowMs * (0.6 + speedNorm * 1.4) + i * 173) % 720;
    const r0 = 80 + phase;
    const r1 = r0 + 40 + speedNorm * 80;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);
    const x0 = cx + cosA * r0;
    const y0 = cy + sinA * r0;
    const x1 = cx + cosA * r1;
    const y1 = cy + sinA * r1;
    // Skip streaks that fall above the horizon (no point streaking the sky).
    if (y0 < horizonY - 12 && y1 < horizonY - 12) continue;
    if ((x0 < -20 && x1 < -20) || (x0 > width + 20 && x1 > width + 20)) continue;
    if (y0 > height + 20 && y1 > height + 20) continue;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
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
