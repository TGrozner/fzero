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
  /** Camera height above ground. */
  height: number;
  /** Distance the camera sits behind the ship. */
  distBehind: number;
  /** Focal length in pixels. Larger = narrower FOV. */
  focal: number;
  /** Screen Y coord of the horizon. */
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
const SEGMENTS_AHEAD = 80;
const SEGMENTS_BEHIND = 2;
const ROT_LERP = 0.18;
const INTERP_DELAY_MS = 80;

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

/** Persistent render state: trails + smoothed camera heading. */
export class RenderState {
  private trails = new Map<string, { x: number; y: number }[]>();
  private smoothedHeading: number | null = null;

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

  reset(): void {
    this.trails.clear();
    this.smoothedHeading = null;
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
  const z = dx * cosH + dy * sinH; // forward distance
  if (z <= NEAR_PLANE) return { sx: 0, sy: 0, depth: z, visible: false };
  const x = -dx * sinH + dy * cosH; // lateral
  const sx = screenW / 2 + (cfg.focal * x) / z;
  const sy = cfg.horizonY + (cfg.focal * cfg.height) / z;
  return { sx, sy, depth: z, visible: true };
};

const drawSky = (rc: RenderContext, horizonY: number): void => {
  const { ctx, width, height } = rc;
  // Sky.
  const sky = ctx.createLinearGradient(0, 0, 0, horizonY);
  sky.addColorStop(0, '#150a3a');
  sky.addColorStop(1, '#3a1758');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, horizonY);
  // Distant grid lines on sky for depth cue.
  ctx.strokeStyle = 'rgba(255, 58, 209, 0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const y = (i / 6) * horizonY;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
  // Horizon line.
  ctx.strokeStyle = '#ff3ad1';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, horizonY);
  ctx.lineTo(width, horizonY);
  ctx.stroke();
  // Ground gradient below horizon.
  const ground = ctx.createLinearGradient(0, horizonY, 0, height);
  ground.addColorStop(0, '#0a0420');
  ground.addColorStop(1, '#06010f');
  ctx.fillStyle = ground;
  ctx.fillRect(0, horizonY, width, height - horizonY);
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
  // Iterate from a few segments behind to many ahead.
  // Project edges of each centerline boundary point.
  const projL: Projected[] = [];
  const projR: Projected[] = [];
  const segIndices: number[] = [];
  for (let off = -SEGMENTS_BEHIND; off <= SEGMENTS_AHEAD; off++) {
    const idx = ((centerSegIdx + off) % N + N) % N;
    const pl = edgePoint(track, idx, 0, 1);
    const pr = edgePoint(track, idx, 0, -1);
    projL.push(project(pl.x, pl.y, cam, cfg, width));
    projR.push(project(pr.x, pr.y, cam, cfg, width));
    segIndices.push(idx);
  }

  // Build quad list with depth (avg z of the four corners) and draw far-to-near.
  type Quad = {
    depth: number;
    aL: Projected;
    bL: Projected;
    bR: Projected;
    aR: Projected;
    fromIdx: number;
    toIdx: number;
  };
  const quads: Quad[] = [];
  for (let i = 0; i < projL.length - 1; i++) {
    const aL = projL[i] as Projected;
    const bL = projL[i + 1] as Projected;
    const aR = projR[i] as Projected;
    const bR = projR[i + 1] as Projected;
    if (!aL.visible || !bL.visible || !aR.visible || !bR.visible) continue;
    const depth = (aL.depth + bL.depth + aR.depth + bR.depth) / 4;
    quads.push({
      depth,
      aL,
      bL,
      bR,
      aR,
      fromIdx: segIndices[i] as number,
      toIdx: segIndices[i + 1] as number,
    });
  }
  // Sort far → near so closer covers farther.
  quads.sort((a, b) => b.depth - a.depth);

  for (const q of quads) {
    // Track surface (purple/blue).
    ctx.fillStyle = q.depth > 80 ? '#1a0d35' : '#22134a';
    ctx.beginPath();
    ctx.moveTo(q.aL.sx, q.aL.sy);
    ctx.lineTo(q.bL.sx, q.bL.sy);
    ctx.lineTo(q.bR.sx, q.bR.sy);
    ctx.lineTo(q.aR.sx, q.aR.sy);
    ctx.closePath();
    ctx.fill();

    // Edge stripes.
    const edgeAlpha = Math.max(0.3, 1 - q.depth / 250);
    ctx.lineWidth = Math.max(1, 3 - q.depth / 80);
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

    // Lane stripe in the middle (solid white dashed).
    if ((q.fromIdx & 1) === 0) {
      const m1x = (q.aL.sx + q.aR.sx) / 2;
      const m1y = (q.aL.sy + q.aR.sy) / 2;
      const m2x = (q.bL.sx + q.bR.sx) / 2;
      const m2y = (q.bL.sy + q.bR.sy) / 2;
      ctx.strokeStyle = `rgba(255, 255, 255, ${edgeAlpha * 0.5})`;
      ctx.lineWidth = Math.max(1, 2 - q.depth / 100);
      ctx.beginPath();
      ctx.moveTo(m1x, m1y);
      ctx.lineTo(m2x, m2y);
      ctx.stroke();
    }
  }

  // Draw start/finish line if visible (always after surface so it sits on top).
  const cpIdx = track.checkpoints[0] as number;
  const a = track.centerline[cpIdx] as { x: number; y: number };
  const b = track.centerline[(cpIdx + 1) % N] as { x: number; y: number };
  const tx = b.x - a.x;
  const ty = b.y - a.y;
  const len = Math.hypot(tx, ty) || 1;
  const nx = -ty / len;
  const ny = tx / len;
  const lA = project(a.x + nx * track.halfWidth, a.y + ny * track.halfWidth, cam, cfg, width);
  const lB = project(a.x - nx * track.halfWidth, a.y - ny * track.halfWidth, cam, cfg, width);
  if (lA.visible && lB.visible) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(2, 5 - lA.depth / 50);
    ctx.beginPath();
    ctx.moveTo(lA.sx, lA.sy);
    ctx.lineTo(lB.sx, lB.sy);
    ctx.stroke();
  }
};

const drawShip = (
  rc: RenderContext,
  cam: CamPose,
  cfg: CamConfig,
  ship: { x: number; y: number; h: number; flags: number },
  player: PlayerInfoMsg | undefined,
  isMe: boolean,
): void => {
  const { ctx, width } = rc;
  const ko = (ship.flags & FLAG_KO) !== 0;
  const sky = (ship.flags & FLAG_SKYWAY) !== 0;
  const boost = (ship.flags & FLAG_FREE_BOOST) !== 0;
  const color = player?.color ?? '#888';

  const pivot = project(ship.x, ship.y, cam, cfg, width);
  if (!pivot.visible) return;

  // Screen size scales with depth, capped to avoid huge sprites near camera.
  const baseSize = isMe ? 22 : 18;
  const size = Math.max(2.5, Math.min(baseSize, (cfg.focal * 2.4) / pivot.depth));
  // Body sprite is drawn with its nose at -Y (canvas up). Camera projection
  // already aligns the camera's forward with screen up, so we just rotate by
  // the ship's heading delta from the camera.
  const relHeading = wrapAngle(ship.h - cam.heading);

  ctx.save();
  ctx.translate(pivot.sx, pivot.sy);
  ctx.rotate(relHeading);
  if (sky) {
    ctx.shadowColor = '#3affe1';
    ctx.shadowBlur = 16;
  }
  ctx.fillStyle = ko ? '#444' : color;
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.9);
  ctx.lineTo(size * 0.7, size * 0.7);
  ctx.lineTo(0, size * 0.4);
  ctx.lineTo(-size * 0.7, size * 0.7);
  ctx.closePath();
  ctx.fill();
  if (isMe && !ko) {
    ctx.lineWidth = Math.max(1, size * 0.12);
    ctx.strokeStyle = '#fff';
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 6;
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  if (boost && !ko) {
    ctx.fillStyle = 'rgba(255, 210, 58, 0.45)';
    ctx.beginPath();
    ctx.moveTo(0, size * 0.5);
    ctx.lineTo(size * 0.4, size * (1.4 + Math.random() * 0.4));
    ctx.lineTo(-size * 0.4, size * (1.4 + Math.random() * 0.4));
    ctx.closePath();
    ctx.fill();
  }
  if (sky) {
    ctx.strokeStyle = 'rgba(58, 255, 225, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, size * 1.2, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
};

export const renderFrame = (
  rc: RenderContext,
  state: ClientState,
  rstate: RenderState,
  nowMs: number,
): void => {
  const { ctx, width, height } = rc;
  const track = findTrack(state.trackId);
  const ships = computeInterpolatedShips(state, nowMs);
  rstate.updateTrails(new Map([...ships.entries()].map(([id, s]) => [id, { x: s.x, y: s.y }])));

  const me = state.myId ? ships.get(state.myId) : undefined;
  if (!me) {
    // Pre-race overview: top-down zoom out.
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

  drawSky(rc, cfg.horizonY);
  // Find the segment closest to ship for centering the track render window.
  const closest = closestOnTrack(track, { x: me.x, y: me.y });
  drawTrack(rc, track, cam, cfg, closest.segIdx);

  // Sort ships by depth (back to front).
  const projected = [...ships.entries()].map(([id, s]) => {
    const p = project(s.x, s.y, cam, cfg, width);
    return { id, ship: s, depth: p.depth };
  });
  projected.sort((a, b) => b.depth - a.depth);
  for (const { id, ship } of projected) {
    drawShip(rc, cam, cfg, ship, state.players[id], id === state.myId);
  }

  void ctx;
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
  const bounds = trackBounds(track);
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const sx = (width - 16) / w;
  const sy = (height - 16) / h;
  const s = Math.min(sx, sy);
  const ox = (width - w * s) / 2 - bounds.minX * s;
  const oy = (height - h * s) / 2 - bounds.minY * s;
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i <= track.centerline.length; i++) {
    const p = track.centerline[i % track.centerline.length] as { x: number; y: number };
    const xx = p.x * s + ox;
    const yy = p.y * s + oy;
    if (i === 0) ctx.moveTo(xx, yy);
    else ctx.lineTo(xx, yy);
  }
  ctx.stroke();
  const last = state.snapshots[state.snapshots.length - 1];
  if (!last) return;
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
    ctx.arc(ship.x * s + ox, ship.y * s + oy, isMe ? 3 : 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
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
