import { useEffect, useRef, useState } from 'react';
import {
  type ClientState,
  type Action,
  findMyShip,
  isDeathCamActive,
  spectatorTargetId,
} from '../state.ts';
import { useGameLoop } from '../hooks/useGameLoop.ts';
import { useKeyboard, keyboardToInput } from '../hooks/useKeyboard.ts';
import { HUD } from './HUD.tsx';
import {
  renderFrame,
  renderMinimap,
  setupCanvas,
  RenderState,
} from '../render/renderer.ts';
import { ProfileOverlay } from './ProfileOverlay.tsx';
import { encodeInput } from '../../shared/protocol.ts';
import type { SocketAPI } from '../hooks/useGameSocket.ts';
import { FLAG_KO } from '../../shared/protocol.ts';
import { useHitPrediction } from './race/useHitPrediction.ts';
import { useLocalPrediction } from './race/useLocalPrediction.ts';
import { useRaceReactor } from './race/useRaceReactor.ts';
import { TouchControls } from './TouchControls.tsx';
import { isTouchDevice } from './isTouchDevice.ts';

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

  const [damageFlash, setDamageFlash] = useState<number>(0);
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
  const input = useKeyboard(true, handlePress);
  const keys = input.ref;

  // Predictor for spin/side attacks. Watches both keydown events (kbd) and
  // rising edges on the unified input ref (touch). Without the latter, taps
  // on the SPIN / Q / E buttons fire the action server-side but produce no
  // local visual / audio feedback, which makes the buttons feel broken.
  const { spinFlash, sideRing, hitMarkers, hitPops } = useHitPrediction(
    state,
    renderRef,
    input,
  );

  // Audio + flying overlays driven by server events.
  const { lapFanfare, positionToast, perfectStart, pbToast } = useRaceReactor(state);

  // Client-side prediction: simulate the local player's ship every frame so
  // input feels reactive instead of tick-rate-bound.
  const prediction = useLocalPrediction(state);

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

  useGameLoop((dt) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rc = setupCanvas(canvas);
    if (!rc) return;
    const now = performance.now();
    // Step the locally-predicted player ship before rendering so this frame's
    // visuals reflect this frame's input — not what arrived in the last
    // server snapshot.
    if (!state.paused && state.phase === 'RACING') {
      prediction.step(dt, keyboardToInput(keys.current));
    }
    if (!state.paused) {
      renderFrame(rc, state, renderRef.current, now, prediction.pose());
    }
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
          const p99 =
            sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? dtMs;
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
        renderMinimap(ctx, state, renderRef.current, rect.width, rect.height, 1 / 60);
      }
    }

    // Send input at the server tick rate (10 Hz). Aligned with SERVER_TICK_HZ
    // so the server has a fresh input every tick — important for racing feel.
    if (state.phase === 'RACING' && state.myId && now - lastInputSentRef.current > 100) {
      lastInputSentRef.current = now;
      const input = keyboardToInput(keys.current);
      socket.send({ type: 'input', ts: now, in: encodeInput(input) });
    }

    // Local damage detection: a sudden power drop triggers shake + flash.
    const me = findMyShip(state);
    if (me) {
      const prev = lastPowerRef.current;
      if (prev !== null && prev - me.p > 0.04 && now > shakeUntilRef.current) {
        if (wrapRef.current) {
          wrapRef.current.classList.remove('shake');
          void wrapRef.current.offsetWidth; // force reflow so anim restarts
          wrapRef.current.classList.add('shake');
          shakeUntilRef.current = now + 220;
        }
        setDamageFlash((c) => c + 1);
      }
      lastPowerRef.current = me.p;
    }
  }, true);

  // Periodic ping for RTT measurement.
  useEffect(() => {
    const interval = setInterval(() => {
      socket.send({ type: 'ping', ts: performance.now() });
    }, 10000);
    return () => clearInterval(interval);
  }, [socket]);

  const ship = findMyShip(state);
  const myKo = ship ? (ship.f & FLAG_KO) !== 0 : false;
  const showCountdown = state.phase === 'COUNTDOWN';
  // Re-render once when the death-cam window expires so the fallback
  // spectator overlay takes over without waiting for the next snapshot.
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!state.deathCam) return;
    const remain = state.deathCam.untilMs - performance.now();
    if (remain <= 0) return;
    const t = window.setTimeout(() => setNow(performance.now()), remain + 50);
    return () => window.clearTimeout(t);
  }, [state.deathCam]);
  const deathCamOn = isDeathCamActive(state);
  const deathCamAttackerName =
    state.deathCam?.attackerId
      ? state.players[state.deathCam.attackerId]?.name ?? state.deathCam.attackerId
      : null;

  return (
    <div className="canvas-wrap" data-testid="race-screen" ref={wrapRef}>
      <canvas ref={canvasRef} />
      <canvas ref={minimapRef} className="minimap" data-testid="minimap" />
      <HUD state={state} />
      {state.spectator && (
        <div
          data-testid="spectator-banner"
          style={{
            position: 'absolute',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '6px 14px',
            borderRadius: 6,
            background: 'rgba(0, 0, 0, 0.6)',
            border: '1px solid rgba(255, 255, 255, 0.18)',
            color: '#fff',
            fontSize: 13,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            pointerEvents: 'none',
          }}
        >
          Spectating · joining next race
        </div>
      )}
      {showCountdown && (
        <div className="countdown-overlay" data-testid="countdown">
          <div className="number">
            {state.countdown > 0 ? Math.ceil(state.countdown) : 'GO'}
          </div>
        </div>
      )}
      {state.paused && (
        <div className="pause-overlay" data-testid="pause">
          <div className="pause-panel">
            <h2>Paused</h2>
            <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -8 }}>
              Press P to resume
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label
                htmlFor="pause-volume"
                style={{
                  fontSize: 11,
                  color: 'var(--muted)',
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                }}
              >
                Volume {Math.round(state.volume * 100)}%
              </label>
              <input
                id="pause-volume"
                data-testid="pause-volume"
                type="range"
                min={0}
                max={100}
                value={Math.round(state.volume * 100)}
                onChange={(e) =>
                  dispatch({ type: 'SET_VOLUME', volume: Number(e.target.value) / 100 })
                }
              />
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  margin: 0,
                  textTransform: 'none',
                  letterSpacing: 0,
                  fontSize: 13,
                  color: 'var(--text)',
                }}
              >
                <input
                  data-testid="pause-music"
                  type="checkbox"
                  checked={state.music}
                  onChange={(e) =>
                    dispatch({ type: 'SET_MUSIC', music: e.target.checked })
                  }
                />
                Music
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
              <button
                data-testid="pause-resume"
                onClick={() => dispatch({ type: 'TOGGLE_PAUSE' })}
              >
                Resume
              </button>
              <button data-testid="pause-leave" onClick={onLeave}>
                Leave
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Death cam: brief tracking shot of whoever KO'd us, with a banner. */}
      {deathCamOn && state.phase === 'RACING' && (
        <div className="death-cam-overlay" data-testid="death-cam">
          <div className="death-cam-tag">
            KO'd by{' '}
            <span style={{ color: 'var(--danger)' }}>
              {deathCamAttackerName ?? 'the track'}
            </span>
          </div>
        </div>
      )}
      {myKo && !deathCamOn && state.phase === 'RACING' && (
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
        <div key={damageFlash} className="fx-damage" data-testid="fx-damage" />
      )}
      {/* Lap completion fanfare overlay. */}
      {lapFanfare && (
        <div className="fx-lap" data-testid="fx-lap" key={lapFanfare.id}>
          LAP {lapFanfare.lap} / 3
        </div>
      )}
      {/* Perfect-start banner. */}
      {perfectStart && (
        <div className="fx-perfect" data-testid="fx-perfect" key={perfectStart.id}>
          PERFECT START!
        </div>
      )}
      {/* Personal-best toast. */}
      {pbToast && (
        <div className="fx-pb" data-testid="fx-pb" key={pbToast.id}>
          {pbToast.label}
        </div>
      )}
      {/* Position-change toast when the local player overtakes. */}
      {positionToast && (
        <div className="fx-position" data-testid="fx-position" key={positionToast.id}>
          P{positionToast.pos}
          <span style={{ marginLeft: 8, color: 'var(--accent-2)' }}>▲</span>
        </div>
      )}
      {profileEnabled && (
        <ProfileOverlay
          fps={profileSnapshot.fps}
          p99={profileSnapshot.p99}
          particles={profileSnapshot.particles}
        />
      )}
      {isTouchDevice() && state.phase === 'RACING' && !myKo && !state.paused && (
        <TouchControls
          input={input}
          onPause={() => dispatch({ type: 'TOGGLE_PAUSE' })}
          onLeave={onLeave}
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
