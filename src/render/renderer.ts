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
const ROT_LERP = 0.18;
const INTERP_DELAY_MS = 80;
const GRID_SIZE = 80;
const FOG_START = 60;
const FOG_END = 480;
const STAR_COUNT = 80;

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
  private stars: { x: number; y: number; r: number; tw: number }[] | null = null;
  private memories = new Map<string, ShipMemory>();
  private particles: Particle[] = [];
  private lastFrameMs: number | null = null;

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

  smoothHeading(target: number): number {
    if (this.smoothedHeading === null) {
      this.smoothedHeading = target;
      return target;
    }
    const delta = wrapAngle(target - this.smoothedHeading);
    this.smoothedHeading = this.smoothedHeading + delta * ROT_LERP;
    return this.smoothedHeading;
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
    // Bank target: -headingDelta proportional to angular speed (rad/s), capped.
    const angVel = dtSec > 0 ? headingDelta / dtSec : 0;
    const target = Math.max(-0.45, Math.min(0.45, angVel * 0.18));
    mem.bank = mem.bank + (target - mem.bank) * 0.25;
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

type EdgePoint = { sx: number; sy: number; depth: number; visible: boolean; wx: number; wy: number };

const projectEdge = (
  wx: number,
  wy: number,
  cam: CamPose,
  cfg: CamConfig,
  screenW: number,
): EdgePoint => {
  const p = project(wx, wy, cam, cfg, screenW);
  return { ...p, wx, wy };
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

  // Project both edges of each segment, with near-plane clipping per side.
  const projL: EdgePoint[] = [];
  const projR: EdgePoint[] = [];
  const segIndices: number[] = [];
  for (let off = -SEGMENTS_BEHIND; off <= SEGMENTS_AHEAD; off++) {
    const idx = ((centerSegIdx + off) % N + N) % N;
    const pl = edgePoint(track, idx, 0, 1);
    const pr = edgePoint(track, idx, 0, -1);
    projL.push(projectEdge(pl.x, pl.y, cam, cfg, width));
    projR.push(projectEdge(pr.x, pr.y, cam, cfg, width));
    segIndices.push(idx);
  }

  // Build clipped quads: if any corner is invisible, clip the corresponding
  // edge segment against the near plane.
  type Quad = {
    depth: number;
    aL: { sx: number; sy: number };
    bL: { sx: number; sy: number };
    bR: { sx: number; sy: number };
    aR: { sx: number; sy: number };
    fromIdx: number;
  };
  const quads: Quad[] = [];
  for (let i = 0; i < projL.length - 1; i++) {
    const aL = projL[i] as EdgePoint;
    const bL = projL[i + 1] as EdgePoint;
    const aR = projR[i] as EdgePoint;
    const bR = projR[i + 1] as EdgePoint;
    // Skip if all four are behind.
    if (!aL.visible && !bL.visible && !aR.visible && !bR.visible) continue;
    // Clip left edge.
    const segL =
      aL.visible && bL.visible
        ? { a: aL, b: bL }
        : projectSegment(aL.wx, aL.wy, bL.wx, bL.wy, cam, cfg, width);
    const segR =
      aR.visible && bR.visible
        ? { a: aR, b: bR }
        : projectSegment(aR.wx, aR.wy, bR.wx, bR.wy, cam, cfg, width);
    if (!segL || !segR) continue;
    const depth = (segL.a.depth + segL.b.depth + segR.a.depth + segR.b.depth) / 4;
    quads.push({
      depth,
      aL: segL.a,
      bL: segL.b,
      aR: segR.a,
      bR: segR.b,
      fromIdx: segIndices[i] as number,
    });
  }
  // Far → near so closer covers farther.
  quads.sort((a, b) => b.depth - a.depth);

  for (const q of quads) {
    const fa = fogAlpha(q.depth);
    if (fa <= 0.01) continue;

    // Track surface: bright enough to read against the synthwave grid.
    const surfaceShade = (q.fromIdx & 1) === 0 ? '#2c1a5a' : '#36206e';
    ctx.fillStyle = surfaceShade;
    ctx.globalAlpha = fa;
    ctx.beginPath();
    ctx.moveTo(q.aL.sx, q.aL.sy);
    ctx.lineTo(q.bL.sx, q.bL.sy);
    ctx.lineTo(q.bR.sx, q.bR.sy);
    ctx.lineTo(q.aR.sx, q.aR.sy);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    // Edge stripes (cyan + magenta) with depth-attenuated width and alpha.
    const edgeAlpha = fa * Math.max(0.35, 1 - q.depth / 220);
    const edgeWidth = Math.max(1, 3 - q.depth / 80);
    ctx.lineWidth = edgeWidth;
    ctx.strokeStyle = `rgba(255, 58, 209, ${edgeAlpha})`;
    ctx.beginPath();
    ctx.moveTo(q.aL.sx, q.aL.sy);
    ctx.lineTo(q.bL.sx, q.bL.sy);
    ctx.stroke();
    ctx.strokeStyle = `rgba(58, 255, 225, ${edgeAlpha})`;
    ctx.beginPath();
    ctx.moveTo(q.aR.sx, q.aR.sy);
    ctx.lineTo(q.bR.sx, q.bR.sy);
    ctx.stroke();

    // Centre lane stripe (every other segment).
    if ((q.fromIdx & 1) === 0) {
      const m1x = (q.aL.sx + q.aR.sx) / 2;
      const m1y = (q.aL.sy + q.aR.sy) / 2;
      const m2x = (q.bL.sx + q.bR.sx) / 2;
      const m2y = (q.bL.sy + q.bR.sy) / 2;
      ctx.strokeStyle = `rgba(255, 255, 255, ${edgeAlpha * 0.45})`;
      ctx.lineWidth = Math.max(1, 2.5 - q.depth / 100);
      ctx.beginPath();
      ctx.moveTo(m1x, m1y);
      ctx.lineTo(m2x, m2y);
      ctx.stroke();
    }
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

  const fa0 = fogAlpha(pivot.depth);
  if (fa0 <= 0.02) return;

  // KO fade-out: ship shrinks + spins + fades over KO_ANIM_S.
  let koProgress = 0;
  if (ko && koElapsed >= 0) {
    koProgress = Math.min(1, koElapsed / KO_ANIM_S);
    if (koProgress >= 1) return; // gone
  }
  const fa = fa0 * (1 - koProgress);

  const baseSize = isMe ? 22 : 17;
  let size = Math.max(2.5, Math.min(baseSize, (cfg.focal * 2.4) / pivot.depth));
  if (ko) size *= 1 - koProgress * 0.6;
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
    drawOverview(rc, track, state, ships);
    return;
  }

  const targetHeading = me.h;
  const heading = rstate.smoothHeading(targetHeading);
  const cosH = Math.cos(heading);
  const sinH = Math.sin(heading);

  const cfg: CamConfig = {
    height: 14,
    distBehind: 28,
    focal: Math.max(280, Math.min(width, height) * 0.5),
    horizonY: height * 0.42,
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

  // Per-frame dt + race time for ship memory + particles.
  const dtSec = rstate.consumeDt(nowMs) / 1000;
  const raceTime = state.snapshots[state.snapshots.length - 1]?.time ?? 0;

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

  const projected = [...ships.entries()].map(([id, s]) => {
    const p = project(s.x, s.y, cam, cfg, width);
    return { id, ship: s, depth: p.depth };
  });
  projected.sort((a, b) => b.depth - a.depth);
  for (const { id, ship } of projected) {
    const mem = memMap.get(id);
    if (!mem) continue;
    const koElapsed = mem.koAt !== null ? raceTime - mem.koAt : -1;
    drawShip(rc, cam, cfg, ship, state.players[id], id === state.myId, nowMs, mem.bank, koElapsed);
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
  width: number,
  height: number,
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
    // Rotate so the player's heading points to the top of the minimap.
    ctx.rotate(-me.h - Math.PI / 2);
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
