/**
 * True when the current device looks touch-primary.
 *
 * We check `(pointer: coarse)` first because it filters out hybrid devices
 * (Surface, Chromebooks with detachable keyboards) where a touchscreen exists
 * but the user is actually driving with a keyboard + mouse — those should
 * NOT see the on-screen controls.
 *
 * Falls back to `navigator.maxTouchPoints > 0` for old browsers without the
 * pointer media query.
 */
export const isTouchDevice = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
      return true;
    }
    // If the device has a fine pointer (mouse / trackpad), it's a desktop —
    // even when a touchscreen is present.
    if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) {
      return false;
    }
  } catch {
    // matchMedia might throw in some embedded contexts; fall through.
  }
  return (navigator?.maxTouchPoints ?? 0) > 0;
};
