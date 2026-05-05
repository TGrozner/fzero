import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isTouchDevice } from './isTouchDevice.ts';

const stubMatchMedia = (
  results: Record<string, boolean>,
): typeof window.matchMedia => {
  return ((q: string) => ({
    matches: results[q] ?? false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
};

describe('isTouchDevice', () => {
  let originalMM: typeof window.matchMedia;
  let originalMTP: number | undefined;
  beforeEach(() => {
    originalMM = window.matchMedia;
    originalMTP = (navigator as { maxTouchPoints?: number }).maxTouchPoints;
  });
  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMM,
    });
    if (originalMTP !== undefined) {
      Object.defineProperty(navigator, 'maxTouchPoints', {
        configurable: true,
        get: () => originalMTP,
      });
    }
  });

  it('returns true when the OS reports a coarse pointer', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: stubMatchMedia({ '(pointer: coarse)': true }),
    });
    expect(isTouchDevice()).toBe(true);
  });

  it('returns false when the OS reports a fine pointer (desktop with touchscreen)', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: stubMatchMedia({ '(pointer: fine)': true }),
    });
    expect(isTouchDevice()).toBe(false);
  });

  it('falls back to maxTouchPoints when matchMedia is unsure', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: stubMatchMedia({}),
    });
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      get: () => 5,
    });
    expect(isTouchDevice()).toBe(true);
  });

  it('returns false on a desktop with no touch capabilities and no matchMedia', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: stubMatchMedia({}),
    });
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      get: () => 0,
    });
    expect(isTouchDevice()).toBe(false);
  });
});
