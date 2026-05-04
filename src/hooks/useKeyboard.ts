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
