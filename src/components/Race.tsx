import { useEffect, useRef } from 'react';
import { type ClientState, type Action, findMyShip } from '../state.ts';
import { useGameLoop } from '../hooks/useGameLoop.ts';
import { useKeyboard, keyboardToInput } from '../hooks/useKeyboard.ts';
import { HUD } from './HUD.tsx';
import { renderFrame, renderMinimap, setupCanvas, RenderState } from '../render/renderer.ts';
import { encodeInput } from '../../shared/protocol.ts';
import type { SocketAPI } from '../hooks/useGameSocket.ts';
import { FLAG_KO } from '../../shared/protocol.ts';

type Props = {
  state: ClientState;
  dispatch: (a: Action) => void;
  socket: SocketAPI;
  onLeave: () => void;
};

export function Race({ state, dispatch, socket, onLeave }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);
  const renderRef = useRef(new RenderState());
  const lastInputSentRef = useRef(0);

  const handlePress = (action: 'pause' | 'menu') => {
    if (action === 'pause') dispatch({ type: 'TOGGLE_PAUSE' });
    if (action === 'menu') onLeave();
  };
  const keys = useKeyboard(true, handlePress);

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
        renderMinimap(ctx, state, rect.width, rect.height);
      }
    }

    // Send input at ~30Hz.
    if (state.phase === 'RACING' && state.myId && now - lastInputSentRef.current > 33) {
      lastInputSentRef.current = now;
      const k = keys.current;
      const input = keyboardToInput(k);
      socket.send({ type: 'input', ts: now, in: encodeInput(input) });
    }
  }, true);

  // Periodic ping for RTT measurement.
  useEffect(() => {
    const interval = setInterval(() => {
      socket.send({ type: 'ping', ts: performance.now() });
    }, 2000);
    return () => clearInterval(interval);
  }, [socket]);

  const ship = findMyShip(state);
  const myKo = ship ? (ship.f & FLAG_KO) !== 0 : false;
  const showCountdown = state.phase === 'COUNTDOWN';

  return (
    <div className="canvas-wrap" data-testid="race-screen">
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
            <p>You're out — watching until the race ends.</p>
            <button onClick={onLeave}>Leave</button>
          </div>
        </div>
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
