import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { type ClientState, findMyShip } from '../../state.ts';
import { FLAG_KO } from '../../../shared/protocol.ts';
import { SIDE_ATTACK_RANGE, SPIN_ATTACK_RADIUS } from '../../../shared/constants.ts';
import { getMixer } from '../../audio/mixer.ts';
import type { RenderState } from '../../render/renderer.ts';

/**
 * Predict hits client-side on attack key press: scan the latest snapshot
 * for enemies in attack range and surface particles + UI overlays so the
 * player gets immediate feedback even before the server confirms.
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
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const mixer = getMixer();
      if (e.code === 'Enter') {
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
      } else if (e.code === 'KeyQ' || e.code === 'KeyE') {
        const dir: -1 | 1 = e.code === 'KeyQ' ? -1 : 1;
        setSideRing(dir);
        renderRef.current.triggerLocalSide(performance.now(), dir);
        mixer.play('side', 0.7);
        if (sideTimer) clearTimeout(sideTimer);
        sideTimer = window.setTimeout(() => setSideRing(null), 320);
        const me = findMyShip(stateRef.current);
        if (me) {
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
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (spinTimer) clearTimeout(spinTimer);
      if (sideTimer) clearTimeout(sideTimer);
    };
  }, [renderRef]);

  return { spinFlash, sideRing, hitMarkers, hitPops };
};
