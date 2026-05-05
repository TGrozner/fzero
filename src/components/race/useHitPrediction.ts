import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { type ClientState, findMyShip } from '../../state.ts';
import { FLAG_KO } from '../../../shared/protocol.ts';
import { SIDE_ATTACK_RANGE, SPIN_ATTACK_RADIUS } from '../../../shared/constants.ts';
import { getMixer } from '../../audio/mixer.ts';
import type { RenderState } from '../../render/renderer.ts';
import type { InputApi } from '../../hooks/useKeyboard.ts';

/**
 * Predict hits client-side on attack press: scan the latest snapshot for
 * enemies in attack range and surface particles + UI overlays so the player
 * gets immediate feedback even before the server confirms. Reacts to BOTH
 * keyboard keydown events AND touch-input bit transitions, so the spin/side
 * visuals + sound fire whether the player is on a desk or a phone.
 */
export type HitPredictionFx = {
  spinFlash: boolean;
  sideRing: -1 | 1 | null;
  hitMarkers: readonly { id: number }[];
  hitPops: readonly { id: number }[];
};

export const useHitPrediction = (
  state: ClientState,
  renderRef: MutableRefObject<RenderState>,
  /** Optional: when provided, rising edges on spin/sideLeft/sideRight in this
   *  ref also trigger the visuals. This is the path used by TouchControls. */
  input?: InputApi,
): HitPredictionFx => {
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const [spinFlash, setSpinFlash] = useState(false);
  const [sideRing, setSideRing] = useState<-1 | 1 | null>(null);
  const [hitMarkers, setHitMarkers] = useState<readonly { id: number }[]>([]);
  const [hitPops, setHitPops] = useState<readonly { id: number }[]>([]);
  const fxIdRef = useRef(0);

  useEffect(() => {
    let spinTimer: number | undefined;
    let sideTimer: number | undefined;
    const popHitMarker = () => {
      const id = ++fxIdRef.current;
      setHitMarkers((prev) => [...prev, { id }]);
      window.setTimeout(() => {
        setHitMarkers((prev) => prev.filter((m) => m.id !== id));
      }, 420);
    };
    const popHitCounter = () => {
      const id = ++fxIdRef.current;
      setHitPops((prev) => [...prev, { id }]);
      window.setTimeout(() => {
        setHitPops((prev) => prev.filter((m) => m.id !== id));
      }, 1000);
    };
    const findHits = (
      filter: (rel: { dx: number; dy: number; dist: number }) => boolean,
    ): { x: number; y: number; id: string }[] => {
      const s = stateRef.current;
      const me = findMyShip(s);
      if (!me) return [];
      const last = s.snapshots[s.snapshots.length - 1];
      if (!last) return [];
      const out: { x: number; y: number; id: string }[] = [];
      for (const ship of last.ships) {
        if (ship.id === me.id) continue;
        if ((ship.f & FLAG_KO) !== 0) continue;
        const dx = ship.x - me.x;
        const dy = ship.y - me.y;
        const dist = Math.hypot(dx, dy);
        if (filter({ dx, dy, dist })) {
          out.push({ x: ship.x, y: ship.y, id: ship.id });
        }
      }
      return out;
    };
    const triggerSpin = () => {
      const mixer = getMixer();
      setSpinFlash(true);
      renderRef.current.triggerLocalSpin(performance.now());
      mixer.play('spin', 0.7);
      if (spinTimer) clearTimeout(spinTimer);
      spinTimer = window.setTimeout(() => setSpinFlash(false), 240);
      const hits = findHits(({ dist }) => dist <= SPIN_ATTACK_RADIUS);
      for (const h of hits) {
        renderRef.current.spawnImpactBurst(h.x, h.y, 'spin', 10);
      }
      if (hits.length > 0) {
        popHitMarker();
        popHitCounter();
      }
    };
    const triggerSide = (dir: -1 | 1) => {
      const mixer = getMixer();
      setSideRing(dir);
      renderRef.current.triggerLocalSide(performance.now(), dir);
      mixer.play('side', 0.7);
      if (sideTimer) clearTimeout(sideTimer);
      sideTimer = window.setTimeout(() => setSideRing(null), 320);
      const me = findMyShip(stateRef.current);
      if (!me) return;
      const cosH = Math.cos(me.h);
      const sinH = Math.sin(me.h);
      const hits = findHits(({ dx, dy, dist }) => {
        if (dist > SIDE_ATTACK_RANGE) return false;
        const lateral = dx * -sinH + dy * cosH; // +ve = right of heading
        return dir === 1 ? lateral > 0 : lateral < 0;
      });
      for (const h of hits) {
        renderRef.current.spawnImpactBurst(
          h.x,
          h.y,
          dir === -1 ? 'side-left' : 'side-right',
          8,
        );
      }
      if (hits.length > 0) {
        popHitMarker();
        popHitCounter();
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === 'Enter') triggerSpin();
      else if (e.code === 'KeyQ') triggerSide(-1);
      else if (e.code === 'KeyE') triggerSide(1);
    };

    // Watch the touch input ref for rising edges on spin/sideLeft/sideRight.
    // We poll via requestAnimationFrame because the input is a ref (not
    // reactive) — the cost is ~16 ms of comparison work per frame, which is
    // negligible vs the rest of the render loop.
    let raf = 0;
    let prev = { spin: false, sideLeft: false, sideRight: false };
    const tick = () => {
      if (input) {
        const cur = input.ref.current;
        if (cur.spin && !prev.spin) triggerSpin();
        if (cur.sideLeft && !prev.sideLeft) triggerSide(-1);
        if (cur.sideRight && !prev.sideRight) triggerSide(1);
        prev = { spin: cur.spin, sideLeft: cur.sideLeft, sideRight: cur.sideRight };
      }
      raf = requestAnimationFrame(tick);
    };
    if (input) raf = requestAnimationFrame(tick);

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (raf) cancelAnimationFrame(raf);
      if (spinTimer) clearTimeout(spinTimer);
      if (sideTimer) clearTimeout(sideTimer);
    };
  }, [renderRef, input]);

  return { spinFlash, sideRing, hitMarkers, hitPops };
};
