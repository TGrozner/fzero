import {
  type Vec2,
  v2,
  add,
  sub,
  scale,
  dot,
  lengthSq,
  distance,
  normalize,
  perp,
  clamp,
  cross,
} from './vec2.ts';

export type Track = {
  readonly id: string;
  readonly name: string;
  /** Closed polyline of centerline points (no duplicate at end). */
  readonly centerline: readonly Vec2[];
  /** Half-width of the track surface in world units. */
  readonly halfWidth: number;
  /** Total length of centerline (sum of segment lengths). */
  readonly length: number;
  /** Cumulative length at start of each segment. Length === centerline.length + 1. */
  readonly cumulative: readonly number[];
  /** Indices into centerline that are checkpoints in race order. The first is start/finish. */
  readonly checkpoints: readonly number[];
  readonly startHeading: Vec2;
  readonly startPosition: Vec2;
};

export const buildTrack = (
  id: string,
  name: string,
  centerline: readonly Vec2[],
  halfWidth: number,
  checkpointCount: number,
): Track => {
  if (centerline.length < 3) throw new Error('Track needs at least 3 points');
  if (halfWidth <= 0) throw new Error('halfWidth must be positive');
  if (checkpointCount < 2) throw new Error('checkpointCount must be >= 2');

  const cumulative: number[] = [0];
  for (let i = 0; i < centerline.length; i++) {
    const a = centerline[i] as Vec2;
    const b = centerline[(i + 1) % centerline.length] as Vec2;
    const segLen = distance(a, b);
    cumulative.push((cumulative[i] as number) + segLen);
  }
  const totalLength = cumulative[centerline.length] as number;

  const checkpoints: number[] = [];
  for (let i = 0; i < checkpointCount; i++) {
    const target = (i * totalLength) / checkpointCount;
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let j = 0; j < centerline.length; j++) {
      const diff = Math.abs((cumulative[j] as number) - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = j;
      }
    }
    if (!checkpoints.includes(bestIdx)) checkpoints.push(bestIdx);
  }

  const start = centerline[checkpoints[0] as number] as Vec2;
  const next = centerline[((checkpoints[0] as number) + 1) % centerline.length] as Vec2;
  const startHeading = normalize(sub(next, start));

  return {
    id,
    name,
    centerline,
    halfWidth,
    length: totalLength,
    cumulative,
    checkpoints,
    startHeading,
    startPosition: start,
  };
};

export type ClosestSegment = {
  segIdx: number;
  t: number;
  projected: Vec2;
  signedDistance: number;
  distance: number;
  arcLength: number;
};

export const closestOnTrack = (track: Track, p: Vec2): ClosestSegment => {
  let bestIdx = 0;
  let bestT = 0;
  let bestDistSq = Infinity;
  let bestProj: Vec2 = track.centerline[0] as Vec2;
  let bestSigned = 0;

  for (let i = 0; i < track.centerline.length; i++) {
    const a = track.centerline[i] as Vec2;
    const b = track.centerline[(i + 1) % track.centerline.length] as Vec2;
    const ab = sub(b, a);
    const ap = sub(p, a);
    const lenSq = lengthSq(ab);
    const t = lenSq === 0 ? 0 : clamp(dot(ap, ab) / lenSq, 0, 1);
    const proj = add(a, scale(ab, t));
    const diff = sub(p, proj);
    const dSq = lengthSq(diff);
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestIdx = i;
      bestT = t;
      bestProj = proj;
      bestSigned = cross(ab, ap) >= 0 ? Math.sqrt(dSq) : -Math.sqrt(dSq);
    }
  }
  const segLen =
    (track.cumulative[bestIdx + 1] as number) - (track.cumulative[bestIdx] as number);
  const arcLength = (track.cumulative[bestIdx] as number) + bestT * segLen;
  return {
    segIdx: bestIdx,
    t: bestT,
    projected: bestProj,
    distance: Math.sqrt(bestDistSq),
    signedDistance: bestSigned,
    arcLength,
  };
};

export const isOnTrack = (track: Track, p: Vec2): boolean => {
  const c = closestOnTrack(track, p);
  return c.distance <= track.halfWidth;
};

export const tangentAt = (track: Track, segIdx: number): Vec2 => {
  const a = track.centerline[segIdx % track.centerline.length] as Vec2;
  const b = track.centerline[(segIdx + 1) % track.centerline.length] as Vec2;
  return normalize(sub(b, a));
};

/** Build a smooth oval centerline. */
export const buildOvalTrack = (
  width: number,
  height: number,
  samples: number,
  perturb = 0,
): Vec2[] => {
  const pts: Vec2[] = [];
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    const r = 1 + perturb * Math.sin(3 * a);
    const x = Math.cos(a) * (width / 2) * r;
    const y = Math.sin(a) * (height / 2) * r;
    pts.push(v2(x, y));
  }
  return pts;
};

/** Build a more technical, peanut-shaped track. */
export const buildPeanutTrack = (samples: number): Vec2[] => {
  const pts: Vec2[] = [];
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    const r = 360 + 80 * Math.sin(2 * a);
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r * 0.6;
    pts.push(v2(x, y));
  }
  return pts;
};

export const edgePoint = (track: Track, segIdx: number, t: number, side: 1 | -1): Vec2 => {
  const a = track.centerline[segIdx % track.centerline.length] as Vec2;
  const b = track.centerline[(segIdx + 1) % track.centerline.length] as Vec2;
  const tangent = normalize(sub(b, a));
  const normal = perp(tangent);
  const center = add(a, scale(sub(b, a), t));
  return add(center, scale(normal, side * track.halfWidth));
};

/** Starting positions for N players: rows of up to 6 staggered behind the start line. */
export const startingGrid = (track: Track, playerCount: number): Vec2[] => {
  const c0 = track.checkpoints[0] as number;
  const a = track.centerline[c0] as Vec2;
  const b = track.centerline[(c0 + 1) % track.centerline.length] as Vec2;
  const tangent = normalize(sub(b, a));
  const normal = perp(tangent);
  const positions: Vec2[] = [];
  const colsPerRow = 6;
  const lateralStep = (track.halfWidth * 1.6) / Math.max(1, colsPerRow - 1);
  const longitudinalStep = 7;
  for (let i = 0; i < playerCount; i++) {
    const row = Math.floor(i / colsPerRow);
    const col = i % colsPerRow;
    const lateral = (col - (colsPerRow - 1) / 2) * lateralStep;
    const longitudinal = -row * longitudinalStep - 4;
    const pos = add(
      a,
      add(scale(tangent, longitudinal), scale(normal, lateral)),
    );
    positions.push(pos);
  }
  return positions;
};

export const pointAt = (track: Track, segIdx: number, t: number): Vec2 => {
  const a = track.centerline[segIdx % track.centerline.length] as Vec2;
  const b = track.centerline[(segIdx + 1) % track.centerline.length] as Vec2;
  return add(a, scale(sub(b, a), t));
};

export const tangentAtArc = (track: Track, arcLength: number): Vec2 => {
  const arc = ((arcLength % track.length) + track.length) % track.length;
  for (let i = 0; i < track.centerline.length; i++) {
    const start = track.cumulative[i] as number;
    const end = track.cumulative[i + 1] as number;
    if (arc >= start && arc <= end) return tangentAt(track, i);
  }
  return track.startHeading;
};

/** Lookahead point along the centerline at distance `ahead` from arcLength. */
export const lookaheadPoint = (track: Track, fromArcLength: number, ahead: number): Vec2 => {
  const arc = ((fromArcLength + ahead) % track.length + track.length) % track.length;
  for (let i = 0; i < track.centerline.length; i++) {
    const start = track.cumulative[i] as number;
    const end = track.cumulative[i + 1] as number;
    if (arc >= start && arc <= end) {
      const segLen = end - start;
      const t = segLen === 0 ? 0 : (arc - start) / segLen;
      return pointAt(track, i, t);
    }
  }
  return track.startPosition;
};

export const trackEdges = (
  track: Track,
  perSegmentSamples = 1,
): { left: Vec2[]; right: Vec2[] } => {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let i = 0; i < track.centerline.length; i++) {
    for (let s = 0; s < perSegmentSamples; s++) {
      const t = s / perSegmentSamples;
      left.push(edgePoint(track, i, t, 1));
      right.push(edgePoint(track, i, t, -1));
    }
  }
  return { left, right };
};

/** Library of tracks available in the game. */
export const TRACKS: readonly Track[] = [
  buildTrack('mute-avenue', 'Mute Avenue', buildOvalTrack(900, 540, 48, 0.18), 44, 4),
  buildTrack('big-blue', 'Big Blue', buildPeanutTrack(56), 50, 4),
];

export const findTrack = (id: string): Track => {
  const t = TRACKS.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown track: ${id}`);
  return t;
};

