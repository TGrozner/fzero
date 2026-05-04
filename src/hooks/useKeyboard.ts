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

const KEY_MAP: Record<string, keyof KeyState> = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  KeyA: 'sideLeft',
  KeyQ: 'sideLeft',
  KeyE: 'sideRight',
  ShiftLeft: 'boost',
  ShiftRight: 'boost',
  Space: 'skyway',
  Enter: 'spin',
  KeyP: 'pause',
  Escape: 'menu',
};

// Note: ArrowLeft maps to 'left'; we set it explicitly here so KeyA and KeyD don't
// collide with steering shortcuts. In practice we use:
// - WASD or arrows for steer/accel/brake
// - Q / E (or A) for side attacks
// We'll bind ArrowLeft → 'left' in addition to KeyA-as-sideLeft.

const KEY_MAP_2: Record<string, keyof KeyState> = {
  ArrowLeft: 'left',
};

const buildMap = (): Record<string, keyof KeyState> => ({ ...KEY_MAP, ...KEY_MAP_2 });

/** Read keyboard state via a ref. The hook returns a getter for the current snapshot. */
export const useKeyboard = (
  enabled: boolean,
  onPress?: (action: 'pause' | 'menu') => void,
): React.MutableRefObject<KeyState> => {
  const stateRef = useRef<KeyState>(empty());
  useEffect(() => {
    if (!enabled) return;
    const map = buildMap();
    const onKeyDown = (e: KeyboardEvent) => {
      const action = map[e.code];
      if (!action) return;
      if (e.repeat) return;
      stateRef.current = { ...stateRef.current, [action]: true };
      if (action === 'pause' && onPress) onPress('pause');
      if (action === 'menu' && onPress) onPress('menu');
      e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const action = map[e.code];
      if (!action) return;
      stateRef.current = { ...stateRef.current, [action]: false };
      e.preventDefault();
    };
    const onBlur = () => {
      stateRef.current = empty();
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
  return stateRef;
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
