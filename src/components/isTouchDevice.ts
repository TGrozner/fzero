/** True when the current device looks touch-primary. */
export const isTouchDevice = (): boolean => {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { ontouchstart?: unknown };
  return 'ontouchstart' in w || (navigator.maxTouchPoints ?? 0) > 0;
};
