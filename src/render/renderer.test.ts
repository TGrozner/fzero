import { describe, expect, it } from 'vitest';
import {
  clipPolygonAgainstZ,
  segmentWindowAhead,
  project,
  RenderState,
  type WorldPt,
} from './renderer.ts';

const w = (x: number, y: number, z: number): WorldPt => ({ x, y, z });

describe('clipPolygonAgainstZ', () => {
  it('returns the polygon unchanged when every vertex is in front of the plane', () => {
    const poly: WorldPt[] = [w(0, 0, 5), w(10, 0, 5), w(10, 10, 5), w(0, 10, 5)];
    const out = clipPolygonAgainstZ(poly, 1);
    expect(out).toEqual(poly);
  });

  it('returns an empty polygon when every vertex is behind the plane', () => {
    const poly: WorldPt[] = [w(0, 0, -1), w(10, 0, -1), w(10, 10, -1)];
    expect(clipPolygonAgainstZ(poly, 1)).toEqual([]);
  });

  it('inserts intersection points when an edge crosses the plane', () => {
    // Triangle with two vertices in front, one behind. The two edges that
    // cross the plane should each contribute one intersection vertex.
    const poly: WorldPt[] = [
      w(0, 0, 4), // in
      w(10, 0, 4), // in
      w(5, 0, -2), // behind
    ];
    const out = clipPolygonAgainstZ(poly, 1);
    // Expected order, walking the polygon: in → in (kept), in→behind (insert),
    // behind→in (insert). So 4 vertices total.
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual(w(0, 0, 4));
    expect(out[1]).toEqual(w(10, 0, 4));
    // First crossing: edge (10,0,4) → (5,0,-2). z goes 4 → -2, plane at z=1,
    // t = (1-4)/(-2-4) = 0.5 → point = (10 + 0.5*(5-10), 0, 1) = (7.5, 0, 1).
    expect(out[2]?.z).toBe(1);
    expect(out[2]?.x).toBeCloseTo(7.5);
    // Second crossing: edge (5,0,-2) → (0,0,4). z goes -2 → 4, t = (1-(-2))/(4-(-2)) = 0.5
    // → point = (5 + 0.5*(0-5), 0, 1) = (2.5, 0, 1).
    expect(out[3]?.z).toBe(1);
    expect(out[3]?.x).toBeCloseTo(2.5);
  });

  it('emits an empty polygon when the input is empty', () => {
    expect(clipPolygonAgainstZ([], 1)).toEqual([]);
  });

  it('produces a closed polygon when a single edge straddles the plane', () => {
    // Two points: one in, one behind. Going around the closed polygon the
    // plane is crossed twice (one each direction), yielding 1 in-vertex + 2
    // intersections = 3 vertices.
    const poly: WorldPt[] = [w(0, 0, 5), w(0, 0, -5)];
    const out = clipPolygonAgainstZ(poly, 0);
    expect(out).toHaveLength(3);
  });

  it('clips a polygon that is wholly behind except for a single nudge in front', () => {
    // Demonstrates that the clip closes the gap correctly: regression for the
    // bug where the original drawTrack just dropped any rib that straddled
    // the near plane, leaving a hole in front of the camera.
    const poly: WorldPt[] = [w(-1, 0, 2), w(1, 0, 2), w(1, 0, -10), w(-1, 0, -10)];
    const out = clipPolygonAgainstZ(poly, 1);
    expect(out.length).toBeGreaterThanOrEqual(3);
    // No output vertex sits behind the plane.
    for (const p of out) expect(p.z).toBeGreaterThanOrEqual(1);
  });
});

describe('segmentWindowAhead', () => {
  it('caps short tracks so the window never wraps the full loop', () => {
    // Oval: 48 segments, 4 behind, 90 desired ahead → cap at 48 - 1 - 4 = 43.
    expect(segmentWindowAhead(48, 4, 90)).toBe(43);
    // Peanut: 56 segments, 4 behind, 90 desired ahead → cap at 51.
    expect(segmentWindowAhead(56, 4, 90)).toBe(51);
  });

  it('passes the desired ahead through when the track is long enough', () => {
    expect(segmentWindowAhead(500, 4, 90)).toBe(90);
  });

  it('clamps to zero when behind already consumes the track', () => {
    expect(segmentWindowAhead(5, 10, 90)).toBe(0);
  });
});

describe('project', () => {
  const cam = { posX: 0, posY: 0, heading: 0 };
  const cfg = { height: 10, distBehind: 0, focal: 200, horizonY: 100 };
  const screenW = 400;

  it('marks points behind the near plane as not visible', () => {
    const p = project(-5, 0, cam, cfg, screenW);
    expect(p.visible).toBe(false);
  });

  it('projects a point straight ahead onto the screen centre at the horizon', () => {
    // World-space point along +x with y=0, looking down +x (heading=0):
    // the perspective projection should leave us at sx = screenW/2 and
    // sy = horizonY + focal*height/depth.
    const p = project(50, 0, cam, cfg, screenW);
    expect(p.visible).toBe(true);
    expect(p.depth).toBeCloseTo(50);
    expect(p.sx).toBeCloseTo(screenW / 2);
    expect(p.sy).toBeCloseTo(cfg.horizonY + (cfg.focal * cfg.height) / 50);
  });

  it('projects laterally offset points consistently to one side of screen centre', () => {
    // With heading=0 (looking down +x), the lateral camera-space x is
    // `-dx*sin0 + dy*cos0 = dy`. So +y world offset → right of screen centre,
    // -y world offset → left. Mirror symmetry across the central axis.
    const right = project(20, 5, cam, cfg, screenW);
    const left = project(20, -5, cam, cfg, screenW);
    expect(right.visible).toBe(true);
    expect(left.visible).toBe(true);
    expect(right.sx).toBeGreaterThan(screenW / 2);
    expect(left.sx).toBeLessThan(screenW / 2);
    expect(right.sx - screenW / 2).toBeCloseTo(screenW / 2 - left.sx);
  });

  it('preserves depth-attenuation: points further away project closer to the horizon', () => {
    const near = project(20, 0, cam, cfg, screenW);
    const far = project(200, 0, cam, cfg, screenW);
    expect(near.sy - cfg.horizonY).toBeGreaterThan(far.sy - cfg.horizonY);
  });
});

describe('RenderState local spin tracking', () => {
  it('returns null when no spin has been triggered', () => {
    const r = new RenderState();
    expect(r.localSpinProgress(1000, 420)).toBeNull();
  });

  it('progresses 0 → 1 over the configured duration', () => {
    const r = new RenderState();
    r.triggerLocalSpin(1000);
    expect(r.localSpinProgress(1000, 400)).toBe(0);
    expect(r.localSpinProgress(1100, 400)).toBeCloseTo(0.25);
    expect(r.localSpinProgress(1200, 400)).toBeCloseTo(0.5);
    expect(r.localSpinProgress(1400, 400)).toBeCloseTo(1);
  });

  it('returns null after the spin duration has elapsed', () => {
    const r = new RenderState();
    r.triggerLocalSpin(1000);
    expect(r.localSpinProgress(1500, 400)).toBeNull();
    expect(r.localSpinProgress(99999, 400)).toBeNull();
  });

  it('returns null for queries before the spin started (clock skew safety)', () => {
    const r = new RenderState();
    r.triggerLocalSpin(1000);
    expect(r.localSpinProgress(900, 400)).toBeNull();
  });

  it('re-triggering resets the start time', () => {
    const r = new RenderState();
    r.triggerLocalSpin(1000);
    r.triggerLocalSpin(2000);
    expect(r.localSpinProgress(2200, 400)).toBeCloseTo(0.5);
  });
});
