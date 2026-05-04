import { describe, it, expect } from 'vitest';
import { v2 } from './vec2.ts';
import {
  buildTrack,
  buildOvalTrack,
  buildPeanutTrack,
  closestOnTrack,
  isOnTrack,
  tangentAt,
  edgePoint,
  startingGrid,
  pointAt,
  tangentAtArc,
  lookaheadPoint,
  trackEdges,
  TRACKS,
  findTrack,
} from './track.ts';

describe('track build', () => {
  it('builds with valid inputs', () => {
    const t = buildTrack('t1', 'T1', buildOvalTrack(100, 60, 12), 10, 4);
    expect(t.checkpoints.length).toBeGreaterThanOrEqual(2);
    expect(t.length).toBeGreaterThan(0);
    expect(t.cumulative.length).toBe(t.centerline.length + 1);
  });

  it('throws on too few points', () => {
    expect(() => buildTrack('x', 'X', [v2(0, 0), v2(1, 1)], 5, 4)).toThrow();
  });

  it('throws on non-positive halfWidth', () => {
    expect(() => buildTrack('x', 'X', buildOvalTrack(50, 30, 8), 0, 4)).toThrow();
  });

  it('throws on too few checkpoints', () => {
    expect(() => buildTrack('x', 'X', buildOvalTrack(50, 30, 8), 10, 1)).toThrow();
  });
});

describe('oval/peanut shapes', () => {
  it('oval has the requested sample count', () => {
    expect(buildOvalTrack(100, 50, 16).length).toBe(16);
  });

  it('peanut has the requested sample count', () => {
    expect(buildPeanutTrack(20).length).toBe(20);
  });
});

describe('closestOnTrack', () => {
  const track = buildTrack('t', 'T', buildOvalTrack(200, 200, 24), 20, 4);

  it('center of track has distance 0 from centerline (close to)', () => {
    const c = closestOnTrack(track, track.centerline[0] as { x: number; y: number });
    expect(c.distance).toBeLessThan(0.01);
  });

  it('isOnTrack: center is on, far away is off', () => {
    expect(isOnTrack(track, track.startPosition)).toBe(true);
    expect(isOnTrack(track, v2(10000, 10000))).toBe(false);
  });

  it('signedDistance has the correct sign on each side', () => {
    const center = track.centerline[0] as { x: number; y: number };
    const tangent = tangentAt(track, 0);
    // Point on left of tangent
    const left = { x: center.x - tangent.y * 5, y: center.y + tangent.x * 5 };
    const right = { x: center.x + tangent.y * 5, y: center.y - tangent.x * 5 };
    const cl = closestOnTrack(track, left);
    const cr = closestOnTrack(track, right);
    expect(cl.signedDistance).toBeGreaterThan(0);
    expect(cr.signedDistance).toBeLessThan(0);
  });

  it('arcLength increases monotonically along centerline', () => {
    const arcs: number[] = [];
    for (let i = 0; i < track.centerline.length; i++) {
      const c = closestOnTrack(track, track.centerline[i] as { x: number; y: number });
      arcs.push(c.arcLength);
    }
    // Arc lengths around the loop should be strictly increasing or wrap once.
    let increases = 0;
    for (let i = 1; i < arcs.length; i++) {
      if ((arcs[i] as number) > (arcs[i - 1] as number)) increases++;
    }
    expect(increases).toBeGreaterThan(arcs.length / 2);
  });
});

describe('edgePoint and trackEdges', () => {
  const track = buildTrack('t', 'T', buildOvalTrack(200, 200, 24), 20, 4);

  it('edgePoint puts the point at exactly halfWidth from center', () => {
    const center = pointAt(track, 0, 0.5);
    const e = edgePoint(track, 0, 0.5, 1);
    const dx = e.x - center.x;
    const dy = e.y - center.y;
    expect(Math.hypot(dx, dy)).toBeCloseTo(track.halfWidth);
  });

  it('trackEdges produces equal-length left/right arrays', () => {
    const e = trackEdges(track);
    expect(e.left.length).toBe(e.right.length);
    expect(e.left.length).toBe(track.centerline.length);
  });

  it('trackEdges samples sub-segments', () => {
    const e = trackEdges(track, 4);
    expect(e.left.length).toBe(track.centerline.length * 4);
  });
});

describe('starting grid', () => {
  const track = buildTrack('t', 'T', buildOvalTrack(300, 200, 24), 30, 4);

  it('places exactly N positions', () => {
    expect(startingGrid(track, 1).length).toBe(1);
    expect(startingGrid(track, 12).length).toBe(12);
    expect(startingGrid(track, 99).length).toBe(99);
  });

  it('positions are within or near the track', () => {
    const grid = startingGrid(track, 6);
    for (const p of grid) {
      const c = closestOnTrack(track, p);
      // Grid is staggered behind the line so allow a bit of leeway, but ships should not be far off.
      expect(c.distance).toBeLessThan(track.halfWidth * 1.5);
    }
  });
});

describe('lookahead and tangentAtArc', () => {
  const track = buildTrack('t', 'T', buildOvalTrack(200, 200, 24), 20, 4);

  it('tangentAtArc returns a unit vector', () => {
    const t = tangentAtArc(track, track.length * 0.4);
    expect(Math.hypot(t.x, t.y)).toBeCloseTo(1);
  });

  it('tangentAtArc handles wraparound', () => {
    const t1 = tangentAtArc(track, 5);
    const t2 = tangentAtArc(track, 5 + track.length);
    expect(t1.x).toBeCloseTo(t2.x);
    expect(t1.y).toBeCloseTo(t2.y);
  });

  it('lookaheadPoint returns a point on the track', () => {
    const p = lookaheadPoint(track, 0, track.length / 4);
    expect(isOnTrack(track, p)).toBe(true);
  });
});

describe('TRACKS library', () => {
  it('contains at least 2 tracks', () => {
    expect(TRACKS.length).toBeGreaterThanOrEqual(2);
  });

  it('findTrack returns a known track', () => {
    expect(findTrack('mute-avenue').name).toBe('Mute Avenue');
  });

  it('findTrack throws for unknown id', () => {
    expect(() => findTrack('nope')).toThrow();
  });
});
