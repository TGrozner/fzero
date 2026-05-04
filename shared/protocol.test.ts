import { describe, it, expect } from 'vitest';
import {
  encode,
  decodeClient,
  decodeServer,
  encodeInput,
  decodeInput,
  snapshotPos,
  FLAG_KO,
  FLAG_FINISHED,
  FLAG_SKYWAY,
  FLAG_FREE_BOOST,
  type ServerMessage,
} from './protocol.ts';

describe('encode/decode round-trip', () => {
  it('decodes a valid client message', () => {
    const msg = { type: 'hello', name: 'Tom', color: '#fff' } as const;
    expect(decodeClient(encode(msg))).toEqual(msg);
  });

  it('decodes a valid server snapshot', () => {
    const msg: ServerMessage = {
      type: 'snapshot',
      tick: 1,
      time: 0.5,
      ships: [
        { id: 'a', x: 1, y: 2, h: 0.1, vx: 3, vy: 4, p: 1, k: 0, l: 0, a: 0, f: 0 },
      ],
      racersLeft: 99,
      pk: 0,
    };
    expect(decodeServer(encode(msg))).toEqual(msg);
  });

  it('rejects malformed JSON', () => {
    expect(decodeClient('not-json')).toBeNull();
    expect(decodeServer('{')).toBeNull();
  });

  it('rejects messages without a type', () => {
    expect(decodeClient('{}')).toBeNull();
    expect(decodeServer('{}')).toBeNull();
  });
});

describe('encodeInput / decodeInput', () => {
  it('round-trips boolean flags', () => {
    const input = {
      throttle: 0.5,
      steer: -0.25,
      boost: true,
      spin: false,
      sideLeft: true,
      sideRight: false,
      skyway: true,
    };
    const out = decodeInput(encodeInput(input));
    expect(out.boost).toBe(true);
    expect(out.skyway).toBe(true);
    expect(out.sideLeft).toBe(true);
    expect(out.sideRight).toBe(false);
    expect(out.spin).toBe(false);
    expect(out.throttle).toBeCloseTo(0.5);
    expect(out.steer).toBeCloseTo(-0.25);
  });

  it('clamps out-of-range throttle/steer', () => {
    const out = decodeInput(encodeInput({
      throttle: 99,
      steer: -99,
      boost: false,
      spin: false,
      sideLeft: false,
      sideRight: false,
      skyway: false,
    }));
    expect(out.throttle).toBe(1);
    expect(out.steer).toBe(-1);
  });
});

describe('flag constants are distinct', () => {
  it('all flags are distinct bits', () => {
    const flags = [FLAG_SKYWAY, FLAG_FREE_BOOST, FLAG_KO, FLAG_FINISHED];
    const set = new Set(flags);
    expect(set.size).toBe(flags.length);
    expect(flags.every((f) => f > 0)).toBe(true);
  });
});

describe('snapshotPos', () => {
  it('extracts x/y as a Vec2', () => {
    expect(snapshotPos({ id: 'a', x: 3, y: 4, h: 0, vx: 0, vy: 0, p: 1, k: 0, l: 0, a: 0, f: 0 })).toEqual({ x: 3, y: 4 });
  });
});
