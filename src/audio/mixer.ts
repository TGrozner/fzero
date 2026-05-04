/**
 * Tiny WebAudio mixer. All SFX are synthesised at runtime — no audio assets
 * to ship — and routed through a master gain so a single slider can mute the
 * whole game.
 *
 * Design notes:
 *   • Each SFX is a one-shot oscillator + envelope chain. We allocate fresh
 *     nodes per call (cheap) and let the engine GC them on stop.
 *   • The class is a no-op when no AudioContext is available (SSR, jsdom).
 *   • Browsers gate AudioContext start until a user gesture; `unlock()` is a
 *     safe idempotent call that resumes the context if needed.
 */

export type SfxKind =
  | 'countdown-tick'
  | 'countdown-go'
  | 'spin'
  | 'side'
  | 'hit'
  | 'ko'
  | 'pickup-boost'
  | 'pickup-heal'
  | 'pickup-mine'
  | 'lap'
  | 'finish'
  | 'wall'
  | 'overtake';

export type AudioSettings = {
  volume: number; // 0..1
  music: boolean;
};

export class AudioMixer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicNodes: { osc: OscillatorNode; lfo: OscillatorNode }[] = [];
  private musicPlaying = false;
  private vol = 0.6;
  private musicEnabled = true;

  /**
   * Lazily build the audio graph. Returns false if we're in an environment
   * without WebAudio (SSR, headless tests).
   */
  private ensure(): boolean {
    if (this.ctx) return true;
    if (typeof window === 'undefined') return false;
    const Ctor =
      (window as unknown as { AudioContext?: typeof AudioContext })
        .AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return false;
    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = this.vol;
      master.connect(ctx.destination);
      const sfx = ctx.createGain();
      sfx.gain.value = 1;
      sfx.connect(master);
      const music = ctx.createGain();
      music.gain.value = this.musicEnabled ? 0.18 : 0;
      music.connect(master);
      this.ctx = ctx;
      this.master = master;
      this.sfxGain = sfx;
      this.musicGain = music;
      return true;
    } catch {
      return false;
    }
  }

  /** Resume the audio context after a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (!this.ensure() || !this.ctx) return;
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  setVolume(v: number): void {
    this.vol = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.vol;
  }

  setMusicEnabled(on: boolean): void {
    this.musicEnabled = on;
    if (this.musicGain) {
      this.musicGain.gain.value = on ? 0.18 : 0;
    }
    if (on && !this.musicPlaying) this.startMusic();
    if (!on && this.musicPlaying) this.stopMusic();
  }

  /**
   * Play a one-shot SFX. Each kind has its own envelope/oscillator profile.
   * Multiple plays are independent — no voice stealing.
   */
  play(kind: SfxKind, gain = 1): void {
    if (!this.ensure() || !this.ctx || !this.sfxGain) return;
    const ctx = this.ctx;
    const dest = this.sfxGain;
    const t = ctx.currentTime;
    switch (kind) {
      case 'countdown-tick':
        beep(ctx, dest, t, { freq: 880, dur: 0.08, type: 'square', gain: 0.18 * gain });
        break;
      case 'countdown-go':
        beep(ctx, dest, t, { freq: 1320, dur: 0.32, type: 'square', gain: 0.28 * gain });
        beep(ctx, dest, t, { freq: 660, dur: 0.5, type: 'sawtooth', gain: 0.18 * gain });
        break;
      case 'spin':
        sweep(ctx, dest, t, { f0: 660, f1: 220, dur: 0.22, type: 'sawtooth', gain: 0.22 * gain });
        break;
      case 'side':
        sweep(ctx, dest, t, { f0: 220, f1: 880, dur: 0.18, type: 'square', gain: 0.18 * gain });
        break;
      case 'hit':
        noiseBurst(ctx, dest, t, { dur: 0.12, gain: 0.32 * gain, lp: 1800 });
        beep(ctx, dest, t, { freq: 180, dur: 0.12, type: 'sine', gain: 0.18 * gain });
        break;
      case 'ko':
        noiseBurst(ctx, dest, t, { dur: 0.6, gain: 0.45 * gain, lp: 800 });
        sweep(ctx, dest, t, { f0: 440, f1: 60, dur: 0.55, type: 'sawtooth', gain: 0.28 * gain });
        break;
      case 'pickup-boost':
        sweep(ctx, dest, t, { f0: 440, f1: 1320, dur: 0.18, type: 'triangle', gain: 0.22 * gain });
        break;
      case 'pickup-heal':
        // A two-tone arpeggio — major third up.
        beep(ctx, dest, t, { freq: 880, dur: 0.12, type: 'triangle', gain: 0.18 * gain });
        beep(ctx, dest, t + 0.09, { freq: 1108, dur: 0.16, type: 'triangle', gain: 0.18 * gain });
        break;
      case 'pickup-mine':
        noiseBurst(ctx, dest, t, { dur: 0.18, gain: 0.32 * gain, lp: 600 });
        beep(ctx, dest, t, { freq: 110, dur: 0.18, type: 'square', gain: 0.22 * gain });
        break;
      case 'lap':
        // C5 → E5 ascend.
        beep(ctx, dest, t, { freq: 523, dur: 0.16, type: 'triangle', gain: 0.22 * gain });
        beep(ctx, dest, t + 0.11, { freq: 659, dur: 0.18, type: 'triangle', gain: 0.22 * gain });
        break;
      case 'finish':
        // Triumphant arpeggio.
        beep(ctx, dest, t, { freq: 523, dur: 0.18, type: 'triangle', gain: 0.26 * gain });
        beep(ctx, dest, t + 0.15, { freq: 659, dur: 0.18, type: 'triangle', gain: 0.26 * gain });
        beep(ctx, dest, t + 0.3, { freq: 784, dur: 0.32, type: 'triangle', gain: 0.3 * gain });
        break;
      case 'wall':
        noiseBurst(ctx, dest, t, { dur: 0.1, gain: 0.28 * gain, lp: 1200 });
        break;
      case 'overtake':
        sweep(ctx, dest, t, { f0: 440, f1: 880, dur: 0.16, type: 'sine', gain: 0.18 * gain });
        break;
    }
  }

  /**
   * Continuous engine-style noise pad whose volume scales with the player's
   * speed (0..1). Cheap and not gated on `musicEnabled`.
   */
  private engineGain: GainNode | null = null;
  private engineOsc: OscillatorNode | null = null;
  setEngineSpeed(speedNorm: number): void {
    if (!this.ensure() || !this.ctx || !this.sfxGain) return;
    const ctx = this.ctx;
    if (!this.engineOsc || !this.engineGain) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 60;
      const g = ctx.createGain();
      g.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 220;
      osc.connect(lp);
      lp.connect(g);
      g.connect(this.sfxGain);
      osc.start();
      this.engineOsc = osc;
      this.engineGain = g;
    }
    const target = Math.max(0, Math.min(1, speedNorm)) * 0.06;
    const targetFreq = 60 + speedNorm * 90;
    this.engineGain.gain.linearRampToValueAtTime(target, ctx.currentTime + 0.08);
    this.engineOsc.frequency.linearRampToValueAtTime(targetFreq, ctx.currentTime + 0.08);
  }

  /**
   * Lo-fi synthwave pad. Two detuned sawtooth voices through a slow LFO on
   * the lowpass cutoff. Stops cleanly via stopMusic().
   */
  private startMusic(): void {
    if (!this.ensure() || !this.ctx || !this.musicGain) return;
    if (this.musicPlaying) return;
    const ctx = this.ctx;
    // A minor 7th chord: A2 (110), C3 (130.81), E3 (164.81), G3 (196).
    const chord = [110, 130.81, 164.81, 196];
    for (const f of chord) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      // LFO for cutoff motion.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.12 + Math.random() * 0.05;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 240;
      lfo.connect(lfoGain);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 480;
      lfoGain.connect(lp.frequency);
      const g = ctx.createGain();
      g.gain.value = 0.4 / chord.length;
      osc.connect(lp);
      lp.connect(g);
      g.connect(this.musicGain);
      osc.start();
      lfo.start();
      this.musicNodes.push({ osc, lfo });
    }
    this.musicPlaying = true;
  }

  private stopMusic(): void {
    if (!this.musicPlaying) return;
    for (const { osc, lfo } of this.musicNodes) {
      try {
        osc.stop();
        lfo.stop();
      } catch {
        // ignore
      }
    }
    this.musicNodes = [];
    this.musicPlaying = false;
  }

  /** Convenience — starts music if enabled. Idempotent. */
  ensureMusic(): void {
    if (!this.musicEnabled) return;
    if (!this.musicPlaying) this.startMusic();
  }
}

const beep = (
  ctx: AudioContext,
  dest: AudioNode,
  t: number,
  opts: { freq: number; dur: number; type: OscillatorType; gain: number },
): void => {
  const osc = ctx.createOscillator();
  osc.type = opts.type;
  osc.frequency.value = opts.freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(opts.gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
  osc.connect(g);
  g.connect(dest);
  osc.start(t);
  osc.stop(t + opts.dur + 0.02);
};

const sweep = (
  ctx: AudioContext,
  dest: AudioNode,
  t: number,
  opts: { f0: number; f1: number; dur: number; type: OscillatorType; gain: number },
): void => {
  const osc = ctx.createOscillator();
  osc.type = opts.type;
  osc.frequency.setValueAtTime(opts.f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.f1), t + opts.dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(opts.gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
  osc.connect(g);
  g.connect(dest);
  osc.start(t);
  osc.stop(t + opts.dur + 0.02);
};

const noiseBurst = (
  ctx: AudioContext,
  dest: AudioNode,
  t: number,
  opts: { dur: number; gain: number; lp: number },
): void => {
  const len = Math.max(1, Math.floor(ctx.sampleRate * opts.dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = opts.lp;
  const g = ctx.createGain();
  g.gain.setValueAtTime(opts.gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
  src.connect(lp);
  lp.connect(g);
  g.connect(dest);
  src.start(t);
  src.stop(t + opts.dur + 0.02);
};

/** Shared singleton. Components should access via `getMixer()`. */
let singleton: AudioMixer | null = null;
export const getMixer = (): AudioMixer => {
  if (!singleton) singleton = new AudioMixer();
  return singleton;
};

/** Reset the singleton — used by tests so each test starts clean. */
export const __resetMixer = (): void => {
  singleton = null;
};
