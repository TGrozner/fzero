import { useEffect, useRef, useState } from 'react';
import { type ClientState, type Action, findMyShip, spectatorTargetId } from '../state.ts';
import { useGameLoop } from '../hooks/useGameLoop.ts';
import { useKeyboard, keyboardToInput } from '../hooks/useKeyboard.ts';
import { HUD } from './HUD.tsx';
import { renderFrame, renderMinimap, setupCanvas, RenderState } from '../render/renderer.ts';
import { ProfileOverlay } from './ProfileOverlay.tsx';
import { encodeInput } from '../../shared/protocol.ts';
import type { SocketAPI } from '../hooks/useGameSocket.ts';
import { FLAG_KO } from '../../shared/protocol.ts';
import {
  SPIN_ATTACK_RADIUS,
  SIDE_ATTACK_RANGE,
} from '../../shared/constants.ts';

type Props = {
  state: ClientState;
  dispatch: (a: Action) => void;
  socket: SocketAPI;
  onLeave: () => void;
};

export function Race({ state, dispatch, socket, onLeave }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const renderRef = useRef(new RenderState());
  const lastInputSentRef = useRef(0);
  const lastPowerRef = useRef<number | null>(null);
  const shakeUntilRef = useRef(0);
  const lastFrameMsRef = useRef<number | null>(null);
  const frameMsAccRef = useRef<number[]>([]);

  const [spinFlash, setSpinFlash] = useState(false);
  const [sideRing, setSideRing] = useState<-1 | 1 | null>(null);
  const [hitMarkers, setHitMarkers] = useState<readonly { id: number }[]>([]);
  const [hitPops, setHitPops] = useState<readonly { id: number }[]>([]);
  const [damageFlash, setDamageFlash] = useState<number>(0);
  const fxIdRef = useRef(0);
  const profileEnabled =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('profile') === '1';
  const [profileSnapshot, setProfileSnapshot] = useState<{
    fps: number;
    p99: number;
    particles: number;
  }>({ fps: 60, p99: 16, particles: 0 });

  const handlePress = (action: 'pause' | 'menu') => {
    if (action === 'pause') dispatch({ type: 'TOGGLE_PAUSE' });
    if (action === 'menu') onLeave();
  };
  const keys = useKeyboard(true, handlePress);

  // Refs to access current state inside the keydown handler without
  // re-binding the listener on every dispatch.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Predictive feedback on attack key presses. We scan the latest snapshot
  // for enemies in attack range and: (a) spawn impact particles at each
  // enemy's world position, (b) trigger a centred hit-marker overlay,
  // (c) push a "+HIT" pop. The server may ignore the input if the cooldown
  // is still active — in that case the prediction is wrong but the visual
  // is brief and harmless.
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
    const popHitCounter = (count: number) => {
      const id = ++fxIdRef.current;
      setHitPops((prev) => [...prev, { id }]);
      window.setTimeout(() => {
        setHitPops((prev) => prev.filter((m) => m.id !== id));
      }, 1000);
      void count;
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
      if (e.code === 'Enter') {
        setSpinFlash(true);
        renderRef.current.triggerLocalSpin(performance.now());
        if (spinTimer) clearTimeout(spinTimer);
        spinTimer = window.setTimeout(() => setSpinFlash(false), 240);
        const hits = findHits(({ dist }) => dist <= SPIN_ATTACK_RADIUS);
        for (const h of hits) {
          renderRef.current.spawnImpactBurst(h.x, h.y, 'spin', 10);
        }
        if (hits.length > 0) {
          popHitMarker();
          popHitCounter(hits.length);
        }
      } else if (e.code === 'KeyQ' || e.code === 'KeyE') {
        const dir: -1 | 1 = e.code === 'KeyQ' ? -1 : 1;
        setSideRing(dir);
        renderRef.current.triggerLocalSide(performance.now(), dir);
        if (sideTimer) clearTimeout(sideTimer);
        sideTimer = window.setTimeout(() => setSideRing(null), 320);
        // Side attack: enemy must be on the corresponding side perpendicular
        // to my heading, within SIDE_ATTACK_RANGE.
        const me = findMyShip(stateRef.current);
        if (me) {
          const cosH = Math.cos(me.h);
          const sinH = Math.sin(me.h);
          // Right vector relative to heading: perpendicular = (-sinH, cosH).
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
            popHitCounter(hits.length);
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
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onResize = () => {
      setupCanvas(canvas);
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  useGameLoop((_dt) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rc = setupCanvas(canvas);
    if (!rc) return;
    const now = performance.now();
    if (!state.paused) renderFrame(rc, state, renderRef.current, now);
    if (profileEnabled) {
      const last = lastFrameMsRef.current;
      lastFrameMsRef.current = now;
      if (last !== null) {
        const dtMs = now - last;
        const acc = frameMsAccRef.current;
        acc.push(dtMs);
        if (acc.length > 90) acc.shift();
        if (acc.length >= 30 && acc.length % 12 === 0) {
          const sorted = [...acc].sort((a, b) => a - b);
          const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? dtMs;
          const avg = acc.reduce((a, b) => a + b, 0) / acc.length;
          setProfileSnapshot({
            fps: Math.round(1000 / Math.max(0.1, avg)),
            p99: Math.round(p99),
            particles: renderRef.current.particleCount(),
          });
        }
      }
    }
    // Minimap.
    const mm = minimapRef.current;
    if (mm) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = mm.getBoundingClientRect();
      mm.width = Math.floor(rect.width * dpr);
      mm.height = Math.floor(rect.height * dpr);
      const ctx = mm.getContext('2d');
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Approx dt for the minimap smoother — we don't need to be exact, the
        // rAF spacing is consistent and the renderer already consumed dt.
        renderMinimap(ctx, state, renderRef.current, rect.width, rect.height, 1 / 60);
      }
    }

    // Send input at the server tick rate (10Hz) — no point sending faster
    // than the server processes, and each message costs a DO request.
    if (state.phase === 'RACING' && state.myId && now - lastInputSentRef.current > 100) {
      lastInputSentRef.current = now;
      const k = keys.current;
      const input = keyboardToInput(k);
      socket.send({ type: 'input', ts: now, in: encodeInput(input) });
    }

    // Detect collision damage on the local ship: a sudden power drop
    // triggers screen shake AND a red damage vignette.
    const me = findMyShip(state);
    if (me) {
      const prev = lastPowerRef.current;
      if (prev !== null && prev - me.p > 0.04 && now > shakeUntilRef.current) {
        if (wrapRef.current) {
          wrapRef.current.classList.remove('shake');
          // Force reflow so the animation restarts even on rapid hits.
          void wrapRef.current.offsetWidth;
          wrapRef.current.classList.add('shake');
          shakeUntilRef.current = now + 220;
        }
        // Each fire bumps a counter, used as React key to retrigger CSS anim.
        setDamageFlash((c) => c + 1);
      }
      lastPowerRef.current = me.p;
    }
  }, true);

  // Periodic ping for RTT measurement (10s — each ping is 2 DO requests).
  useEffect(() => {
    const interval = setInterval(() => {
      socket.send({ type: 'ping', ts: performance.now() });
    }, 10000);
    return () => clearInterval(interval);
  }, [socket]);

  const ship = findMyShip(state);
  const myKo = ship ? (ship.f & FLAG_KO) !== 0 : false;
  const showCountdown = state.phase === 'COUNTDOWN';

  return (
    <div className="canvas-wrap" data-testid="race-screen" ref={wrapRef}>
      <canvas ref={canvasRef} />
      <canvas ref={minimapRef} className="minimap" data-testid="minimap" />
      <HUD state={state} />
      {showCountdown && (
        <div className="countdown-overlay" data-testid="countdown">
          <div className="number">
            {state.countdown > 0 ? Math.ceil(state.countdown) : 'GO'}
          </div>
        </div>
      )}
      {state.paused && (
        <div className="pause-overlay" data-testid="pause">
          <h2>Paused</h2>
        </div>
      )}
      {myKo && state.phase === 'RACING' && (
        <div className="spectator-overlay" data-testid="spectator">
          <div className="panel">
            <h3>KO'd</h3>
            <p>
              {(() => {
                const id = spectatorTargetId(state);
                const name = id ? state.players[id]?.name ?? id : null;
                return name
                  ? `Spectating ${name} until the race ends.`
                  : "You're out — watching until the race ends.";
              })()}
            </p>
            <button onClick={onLeave}>Leave</button>
          </div>
        </div>
      )}
      {/* Attack flash overlays (purely visual). */}
      {spinFlash && <div className="fx-flash" data-testid="fx-spin" />}
      {sideRing !== null && (
        <div
          className={`fx-side-ring ${sideRing === -1 ? 'left' : 'right'}`}
          data-testid="fx-side"
        />
      )}
      {/* +1 KO popups for KOs the local player scored. */}
      <div className="fx-kos" data-testid="fx-kos">
        {state.myKos.map((k) => (
          <div key={`${k.id}-${k.at}`} className="fx-ko-pop">+1 KO</div>
        ))}
      </div>
      {/* "+HIT" pops for non-lethal predicted hits. */}
      <div className="fx-hits" data-testid="fx-hits">
        {hitPops.map((h) => (
          <div key={h.id} className="fx-hit-pop">+HIT</div>
        ))}
      </div>
      {/* Centred crosshair flash when an attack lands on at least one enemy. */}
      {hitMarkers.map((m) => (
        <div key={m.id} className="fx-hitmarker" data-testid="fx-hitmarker" />
      ))}
      {/* Red damage vignette when the local player takes a meaningful hit. */}
      {damageFlash > 0 && (
        <div
          key={damageFlash}
          className="fx-damage"
          data-testid="fx-damage"
        />
      )}
      {profileEnabled && (
        <ProfileOverlay
          fps={profileSnapshot.fps}
          p99={profileSnapshot.p99}
          particles={profileSnapshot.particles}
        />
      )}
      {state.rttMs !== null && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            fontSize: 11,
            color: 'var(--muted)',
            zIndex: 50,
          }}
          data-testid="rtt"
        >
          {Math.round(state.rttMs)}ms
        </div>
      )}
    </div>
  );
}
