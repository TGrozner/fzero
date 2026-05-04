import { useEffect, useRef } from 'react';

export type KeyState = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  boost: boolean;
  spin: boolean;
  sideLeft: boolean;
  sideRight: boolean;
  skyway: boolean;
  pause: boolean;
  menu: boolean;
};

const empty = (): KeyState => ({
  up: false,
  down: false,
  left: false,
  right: false,
  boost: false,
  spin: false,
  sideLeft: false,
  sideRight: false,
  skyway: false,
  pause: false,
  menu: false,
});

// WASD = steer/accel/brake, Q/E = side attacks, Enter = spin, Shift = boost,
// Space = skyway, P = pause, Esc = menu.
const KEY_MAP: Record<string, keyof KeyState> = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  KeyQ: 'sideLeft',
  KeyE: 'sideRight',
  ShiftLeft: 'boost',
  ShiftRight: 'boost',
  Space: 'skyway',
  Enter: 'spin',
  KeyP: 'pause',
  Escape: 'menu',
};

const buildMap = (): Record<string, keyof KeyState> => KEY_MAP;

/**
 * Unified input state. Returns a ref that game-loop reads each tick PLUS
 * a `setAction` setter that touch controls (or any other input source)
 * can call to drive the same action bits as the keyboard.
 *
 * The ref always contains the OR-combined state of every source — i.e. as
 * long as any source has the action true, the ref reads true. We track
 * sources separately so a touch release doesn't clobber a key that's
 * still held, and vice versa.
 */
export type InputSource = 'kbd' | 'touch';
export type InputApi = {
  ref: React.MutableRefObject<KeyState>;
  setAction: (source: InputSource, action: keyof KeyState, value: boolean) => void;
};

export const useKeyboard = (
  enabled: boolean,
  onPress?: (action: 'pause' | 'menu') => void,
): InputApi => {
  const stateRef = useRef<KeyState>(empty());
  // Per-source state — combined into stateRef on every mutation.
  const sourcesRef = useRef<Record<InputSource, KeyState>>({
    kbd: empty(),
    touch: empty(),
  });

  const recompute = (): void => {
    const merged = empty();
    for (const action of Object.keys(merged) as (keyof KeyState)[]) {
      merged[action] =
        sourcesRef.current.kbd[action] || sourcesRef.current.touch[action];
    }
    stateRef.current = merged;
  };

  const setAction = (
    source: InputSource,
    action: keyof KeyState,
    value: boolean,
  ): void => {
    sourcesRef.current[source] = { ...sourcesRef.current[source], [action]: value };
    recompute();
  };

  useEffect(() => {
    if (!enabled) return;
    const map = buildMap();
    const onKeyDown = (e: KeyboardEvent) => {
      const action = map[e.code];
      if (!action) return;
      if (e.repeat) return;
      sourcesRef.current.kbd = { ...sourcesRef.current.kbd, [action]: true };
      recompute();
      if (action === 'pause' && onPress) onPress('pause');
      if (action === 'menu' && onPress) onPress('menu');
      e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const action = map[e.code];
      if (!action) return;
      sourcesRef.current.kbd = { ...sourcesRef.current.kbd, [action]: false };
      recompute();
      e.preventDefault();
    };
    const onBlur = () => {
      sourcesRef.current.kbd = empty();
      recompute();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [enabled, onPress]);

  return { ref: stateRef, setAction };
};

/** Map raw keyboard state to game input fields. */
export const keyboardToInput = (k: KeyState): {
  throttle: number;
  steer: number;
  boost: boolean;
  spin: boolean;
  sideLeft: boolean;
  sideRight: boolean;
  skyway: boolean;
} => ({
  throttle: (k.up ? 1 : 0) + (k.down ? -1 : 0),
  steer: (k.left ? -1 : 0) + (k.right ? 1 : 0),
  boost: k.boost,
  spin: k.spin,
  sideLeft: k.sideLeft,
  sideRight: k.sideRight,
  skyway: k.skyway,
});
