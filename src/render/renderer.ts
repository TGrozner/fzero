import type { ShipSnapshot } from '../../shared/protocol.ts';
import { FLAG_FREE_BOOST, FLAG_KO, FLAG_SKYWAY } from '../../shared/protocol.ts';
import type { Track } from '../../shared/track.ts';
import { trackEdges } from '../../shared/track.ts';
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

/**
 * F-Zero-style "world rotates around the ship" camera.
 * The world point (worldX, worldY) is rendered at screen (anchorX, anchorY),
 * with the world rotated by `rotation` so the ship's heading points up.
 */
export type Camera = {
  worldX: number;
  worldY: number;
  zoom: number;
  rotation: number;
  anchorX: number;
  anchorY: number;
};

const VIEW_BASE = 520; // base world units across the smaller screen dimension at speed 0
const VIEW_SPEED_FACTOR = 1.0;
const ANCHOR_Y_FRAC = 0.72; // ship near the lower part of the screen
const ROT_LERP = 0.18; // smoothing factor on rotation per frame

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

const INTERP_DELAY_MS = 80;

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

/** Persistent render state: trails + smoothed camera rotation. */
export class RenderState {
  private trails = new Map<string, { x: number; y: number }[]>();
  /** Last applied camera rotation (radians), used for smoothing. */
  private smoothedRotation: number | null = null;

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

  /** Smooth a target rotation toward the previous value. */
  smoothRotation(target: number): number {
    if (this.smoothedRotation === null) {
      this.smoothedRotation = target;
      return target;
    }
    const delta = wrapAngle(target - this.smoothedRotation);
    this.smoothedRotation = this.smoothedRotation + delta * ROT_LERP;
    return this.smoothedRotation;
  }

  reset(): void {
    this.trails.clear();
    this.smoothedRotation = null;
  }
}

/** Apply the camera transform on the canvas (translate → rotate → scale → translate). */
const applyCamera = (ctx: CanvasRenderingContext2D, cam: Camera): void => {
  ctx.translate(cam.anchorX, cam.anchorY);
  ctx.rotate(cam.rotation);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.worldX, -cam.worldY);
};

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

const drawTrack = (rc: RenderContext, track: Track, cam: Camera) => {
  const { ctx } = rc;
  ctx.save();
  applyCamera(ctx, cam);

  // Track surface.
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

  // Inner glow.
  ctx.strokeStyle = '#231445';
  ctx.lineWidth = Math.max(1, track.halfWidth * 1.7);
  ctx.beginPath();
  for (let i = 0; i < track.centerline.length; i++) {
    const p = track.centerline[i] as { x: number; y: number };
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.stroke();

  // Edges.
  const edges = trackEdges(track, 1);
  ctx.strokeStyle = 'rgba(255, 58, 209, 0.7)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  edges.left.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(58, 255, 225, 0.7)';
  ctx.beginPath();
  edges.right.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();

  // Start/finish line.
  if (track.checkpoints.length > 0) {
    const idx = track.checkpoints[0] as number;
    const a = track.centerline[idx] as { x: number; y: number };
    const b = track.centerline[(idx + 1) % track.centerline.length] as { x: number; y: number };
    const tx = b.x - a.x;
    const ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x + nx * track.halfWidth, a.y + ny * track.halfWidth);
    ctx.lineTo(a.x - nx * track.halfWidth, a.y - ny * track.halfWidth);
    ctx.stroke();
    const segments = 10;
    for (let i = 0; i < segments; i++) {
      if (i % 2 === 0) continue;
      ctx.fillStyle = '#fff';
      const t1 = (i / segments - 0.5) * 2 * track.halfWidth;
      const t2 = ((i + 1) / segments - 0.5) * 2 * track.halfWidth;
      const x1 = a.x + nx * t1;
      const y1 = a.y + ny * t1;
      const x2 = a.x + nx * t2;
      const y2 = a.y + ny * t2;
      ctx.fillRect(Math.min(x1, x2) - 0.5, Math.min(y1, y2) - 1.5, Math.abs(x2 - x1) + 1, 3);
    }
  }

  // Other checkpoints (subtle dashed).
  for (let i = 1; i < track.checkpoints.length; i++) {
    const idx = track.checkpoints[i] as number;
    const a = track.centerline[idx] as { x: number; y: number };
    const b = track.centerline[(idx + 1) % track.centerline.length] as { x: number; y: number };
    const tx = b.x - a.x;
    const ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;
    ctx.strokeStyle = 'rgba(255, 210, 58, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x + nx * track.halfWidth, a.y + ny * track.halfWidth);
    ctx.lineTo(a.x - nx * track.halfWidth, a.y - ny * track.halfWidth);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
};

const drawShip = (
  rc: RenderContext,
  cam: Camera,
  ship: { x: number; y: number; h: number; vx: number; vy: number; flags: number },
  player: PlayerInfoMsg | undefined,
  isMe: boolean,
  trail: readonly { x: number; y: number }[],
) => {
  const { ctx } = rc;
  const ko = (ship.flags & FLAG_KO) !== 0;
  const sky = (ship.flags & FLAG_SKYWAY) !== 0;
  const boost = (ship.flags & FLAG_FREE_BOOST) !== 0;
  const color = player?.color ?? '#888';

  ctx.save();
  applyCamera(ctx, cam);

  // Trail.
  if (trail.length > 1) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 2 + (boost ? 2 : 0);
    ctx.beginPath();
    for (let i = 0; i < trail.length; i++) {
      const p = trail[i] as { x: number; y: number };
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Ship body.
  ctx.translate(ship.x, ship.y);
  ctx.rotate(ship.h);
  if (sky) {
    ctx.shadowColor = '#3affe1';
    ctx.shadowBlur = 18;
  }
  ctx.fillStyle = ko ? '#444' : color;
  ctx.beginPath();
  ctx.moveTo(8, 0);
  ctx.lineTo(-6, 5);
  ctx.lineTo(-3, 0);
  ctx.lineTo(-6, -5);
  ctx.closePath();
  ctx.fill();
  if (isMe && !ko) {
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = '#fff';
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 8;
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  if (boost && !ko) {
    ctx.fillStyle = 'rgba(255, 210, 58, 0.4)';
    ctx.beginPath();
    ctx.moveTo(-4, 0);
    ctx.lineTo(-12 - Math.random() * 4, 3);
    ctx.lineTo(-12 - Math.random() * 4, -3);
    ctx.closePath();
    ctx.fill();
  }
  if (sky) {
    ctx.strokeStyle = 'rgba(58, 255, 225, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, 12, 0, Math.PI * 2);
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
  // Background.
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, '#0a0420');
  grad.addColorStop(1, '#06010f');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  const track = findTrack(state.trackId);
  const ships = computeInterpolatedShips(state, nowMs);
  rstate.updateTrails(new Map([...ships.entries()].map(([id, s]) => [id, { x: s.x, y: s.y }])));

  const me = state.myId ? ships.get(state.myId) : undefined;
  const cam = me
    ? buildShipCamera(width, height, me, rstate)
    : buildOverviewCamera(width, height, track);

  drawTrack(rc, track, cam);

  // Draw KO ships first, then alive, then me on top.
  const drawOrder = [...ships.entries()].sort(([, a], [, b]) => {
    const aKo = (a.flags & FLAG_KO) !== 0 ? 0 : 1;
    const bKo = (b.flags & FLAG_KO) !== 0 ? 0 : 1;
    return aKo - bKo;
  });
  for (const [id, s] of drawOrder) {
    if (id === state.myId) continue;
    drawShip(rc, cam, s, state.players[id], false, rstate.trail(id));
  }
  if (me && state.myId) {
    drawShip(rc, cam, me, state.players[state.myId], true, rstate.trail(state.myId));
  }
};

const buildShipCamera = (
  width: number,
  height: number,
  ship: { x: number; y: number; h: number; vx: number; vy: number },
  rstate: RenderState,
): Camera => {
  const speed = Math.hypot(ship.vx, ship.vy);
  const view = VIEW_BASE + speed * VIEW_SPEED_FACTOR;
  const minDim = Math.min(width, height);
  const zoom = minDim / view;
  // Rotate the world so the ship's heading points to screen up (-PI/2 in canvas y-down).
  const targetRotation = -ship.h - Math.PI / 2;
  const rotation = rstate.smoothRotation(targetRotation);
  return {
    worldX: ship.x,
    worldY: ship.y,
    zoom,
    rotation,
    anchorX: width / 2,
    anchorY: height * ANCHOR_Y_FRAC,
  };
};

const buildOverviewCamera = (width: number, height: number, track: Track): Camera => {
  const bounds = trackBounds(track);
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const cx = (bounds.maxX + bounds.minX) / 2;
  const cy = (bounds.maxY + bounds.minY) / 2;
  return {
    worldX: cx,
    worldY: cy,
    zoom: Math.min(width / w, height / h) * 0.85,
    rotation: 0,
    anchorX: width / 2,
    anchorY: height / 2,
  };
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

