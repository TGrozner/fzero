import { bench, describe } from 'vitest';
import { clipPolygonAgainstZ, computeInterpolatedShips, type WorldPt } from './renderer.ts';
import { buildInitialClientState } from '../state.ts';
import type { ShipSnapshot } from '../../shared/protocol.ts';

/**
 * Micro-benchmarks for the rendering hot path. Run with `npx vitest bench`.
 *
 * The clip operates on a closed polygon built per frame from the visible
 * track band. With 3 sub-samples per segment over the full ~50-segment
 * window, the polygon has ~300 vertices. We benchmark with 200 and 600
 * vertices so a future tessellation bump shows up here before it shows up
 * as a frame drop in the browser.
 */

const buildBandPoly = (vertexCount: number, frontFraction: number): WorldPt[] => {
  // A ring-shaped band wrapping around z so part is in front, part behind.
  const out: WorldPt[] = [];
  for (let i = 0; i < vertexCount; i++) {
    const t = i / vertexCount;
    const a = t * Math.PI * 2;
    // Offset z so `frontFraction` of the polygon sits in front of z=0.
    const radius = 100;
    const center = radius * (frontFraction * 2 - 1);
    out.push({
      x: Math.cos(a) * radius,
      y: Math.sin(a) * 30,
      z: center + Math.cos(a) * radius,
    });
  }
  return out;
};

/**
 * Synthesize a 99-ship state with two snapshots so the interpolation path
 * runs the actual lerp branch, not the early-return.
 */
const buildShipState = (count: number) => {
  const mkSnap = (offset: number): { ships: ShipSnapshot[]; receivedAt: number } => ({
    receivedAt: 1000 + offset,
    ships: Array.from({ length: count }, (_, i) => ({
      id: `s${i}`,
      x: (i % 16) * 30 + offset * 5,
      y: Math.floor(i / 16) * 30,
      h: (i / count) * Math.PI * 2,
      vx: 30,
      vy: 0,
      p: 1,
      k: 0,
      l: 0,
      a: i,
      f: 0,
    })),
  });
  const a = mkSnap(0);
  const b = mkSnap(50);
  return {
    ...buildInitialClientState(),
    snapshots: [
      { tick: 0, time: 0, receivedAt: a.receivedAt, ships: a.ships, racersLeft: count, pk: 0 },
      { tick: 1, time: 0.05, receivedAt: b.receivedAt, ships: b.ships, racersLeft: count, pk: 0 },
    ],
  };
};

describe('computeInterpolatedShips', () => {
  const s99 = buildShipState(99);
  const s50 = buildShipState(50);
  bench('99 ships, mid-interpolation', () => {
    computeInterpolatedShips(s99, 1080);
  });
  bench('50 ships, mid-interpolation', () => {
    computeInterpolatedShips(s50, 1080);
  });
});

describe('clipPolygonAgainstZ', () => {
  const small = buildBandPoly(200, 0.5);
  const large = buildBandPoly(600, 0.5);
  const fullyIn = buildBandPoly(200, 1);
  const fullyOut = buildBandPoly(200, 0);

  bench('200 vertices, half straddling', () => {
    clipPolygonAgainstZ(small, 0.5);
  });

  bench('600 vertices, half straddling', () => {
    clipPolygonAgainstZ(large, 0.5);
  });

  bench('200 vertices, fully in front (no work)', () => {
    clipPolygonAgainstZ(fullyIn, 0.5);
  });

  bench('200 vertices, fully behind (early-out)', () => {
    clipPolygonAgainstZ(fullyOut, 0.5);
  });
});
