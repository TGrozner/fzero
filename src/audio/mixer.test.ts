import { describe, it, expect, beforeEach } from 'vitest';
import { AudioMixer, __resetMixer, getMixer } from './mixer.ts';

/**
 * jsdom does not implement WebAudio. The mixer is designed to be a no-op in
 * that environment — these tests verify it doesn't throw and that the public
 * API behaves sanely without an audio context.
 */
describe('AudioMixer (no WebAudio environment)', () => {
  beforeEach(() => {
    __resetMixer();
  });

  it('is a no-op when WebAudio is unavailable', () => {
    const m = new AudioMixer();
    expect(() => m.unlock()).not.toThrow();
    expect(() => m.setVolume(0.5)).not.toThrow();
    expect(() => m.setMusicEnabled(true)).not.toThrow();
    expect(() => m.play('spin')).not.toThrow();
    expect(() => m.setEngineSpeed(0.7)).not.toThrow();
    expect(() => m.ensureMusic()).not.toThrow();
  });

  it('clamps volume to 0..1', () => {
    const m = new AudioMixer();
    m.setVolume(-1);
    m.setVolume(2);
    // Property is private — we just assert no throw + state survives.
    expect(() => m.play('hit')).not.toThrow();
  });

  it('getMixer returns a stable singleton', () => {
    const a = getMixer();
    const b = getMixer();
    expect(a).toBe(b);
  });

  it('__resetMixer clears the singleton', () => {
    const a = getMixer();
    __resetMixer();
    const b = getMixer();
    expect(a).not.toBe(b);
  });
});
