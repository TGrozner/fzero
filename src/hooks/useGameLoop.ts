import { useEffect, useRef } from 'react';

/**
 * Run a callback at every animation frame. The callback receives dt (seconds)
 * since the previous call. Pass `enabled = false` to pause the loop.
 */
export const useGameLoop = (cb: (dt: number) => void, enabled: boolean): void => {
  const cbRef = useRef(cb);
  useEffect(() => {
    cbRef.current = cb;
  }, [cb]);
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      cbRef.current(dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);
};
