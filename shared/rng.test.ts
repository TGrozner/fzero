import { describe, it, expect } from 'vitest';
import { createRng, hashString } from './rng.ts';

describe('rng', () => {
  it('is deterministic given the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 20; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('produces different values for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it('next is in [0, 1)', () => {
    const r = createRng(7);
    for (let i = 0; i < 200; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('int returns inclusive range', () => {
    const r = createRng(123);
    for (let i = 0; i < 100; i++) {
      const v = r.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
    }
  });

  it('int throws when max < min', () => {
    const r = createRng(0);
    expect(() => r.int(10, 1)).toThrow();
  });

  it('range produces continuous values', () => {
    const r = createRng(99);
    for (let i = 0; i < 50; i++) {
      const v = r.range(-5, 5);
      expect(v).toBeGreaterThanOrEqual(-5);
      expect(v).toBeLessThan(5);
    }
  });

  it('pick returns a member of the array', () => {
    const r = createRng(11);
    const arr = ['a', 'b', 'c'];
    for (let i = 0; i < 30; i++) {
      expect(arr).toContain(r.pick(arr));
    }
  });

  it('pick throws on empty array', () => {
    const r = createRng(0);
    expect(() => r.pick([])).toThrow();
  });

  it('bool follows probability', () => {
    const r = createRng(5);
    let trues = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) if (r.bool(0.7)) trues++;
    expect(trues / N).toBeGreaterThan(0.6);
    expect(trues / N).toBeLessThan(0.8);
  });

  it('seed exposes the initial seed', () => {
    expect(createRng(42).seed()).toBe(42);
  });
});

describe('hashString', () => {
  it('produces a 32-bit unsigned integer', () => {
    const h = hashString('hello');
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(2 ** 32);
  });

  it('is deterministic', () => {
    expect(hashString('player1')).toBe(hashString('player1'));
  });

  it('differs for different inputs', () => {
    expect(hashString('a')).not.toBe(hashString('b'));
  });
});
