import { useEffect, useRef } from 'react';
import type { InputApi, KeyState } from '../hooks/useKeyboard.ts';

type Props = {
  input: InputApi;
};

/**
 * Touch / pointer control overlay. Active only on touch devices. Uses
 * pointer events so it works on iPhone/Android/desktop touchscreens
 * without spinning up a separate gesture lib.
 *
 * Layout:
 *   • Bottom-left: virtual joystick (drag from anywhere in the left half).
 *     y < 0 → up=true (throttle), y > 0 → down=true (brake), |x| → left/right.
 *   • Bottom-right: 4 action buttons — SPIN, Q, E, BOOST. Tap-and-hold OK.
 *   • Top-right: SKYWAY (always shown — server gates on KO meter).
 *
 * Each button writes via `setAction` on press and clears on release/cancel.
 * The hook combines touch with keyboard via OR so concurrent inputs work.
 */
export function TouchControls({ input }: Props) {
  const padRef = useRef<HTMLDivElement | null>(null);
  // Active joystick gesture: pointer id + start position.
  const activePointerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const pad = padRef.current;
    if (!pad) return;
    const setStick = (dx: number, dy: number) => {
      // Normalize: dead-zone radius 12px, full deflection at 80px.
      const len = Math.hypot(dx, dy);
      if (len < 12) {
        input.setAction('touch', 'up', false);
        input.setAction('touch', 'down', false);
        input.setAction('touch', 'left', false);
        input.setAction('touch', 'right', false);
        return;
      }
      const nx = dx / Math.max(len, 1);
      const ny = dy / Math.max(len, 1);
      // Threshold: any axis component > 0.35 of full deflection is "on".
      input.setAction('touch', 'left', nx < -0.35);
      input.setAction('touch', 'right', nx > 0.35);
      input.setAction('touch', 'up', ny < -0.35);
      input.setAction('touch', 'down', ny > 0.6);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (activePointerRef.current !== null) return;
      activePointerRef.current = e.pointerId;
      startRef.current = { x: e.clientX, y: e.clientY };
      pad.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return;
      const start = startRef.current;
      if (!start) return;
      setStick(e.clientX - start.x, e.clientY - start.y);
    };
    const release = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return;
      activePointerRef.current = null;
      startRef.current = null;
      input.setAction('touch', 'up', false);
      input.setAction('touch', 'down', false);
      input.setAction('touch', 'left', false);
      input.setAction('touch', 'right', false);
    };
    pad.addEventListener('pointerdown', onPointerDown);
    pad.addEventListener('pointermove', onPointerMove);
    pad.addEventListener('pointerup', release);
    pad.addEventListener('pointercancel', release);
    return () => {
      pad.removeEventListener('pointerdown', onPointerDown);
      pad.removeEventListener('pointermove', onPointerMove);
      pad.removeEventListener('pointerup', release);
      pad.removeEventListener('pointercancel', release);
    };
  }, [input]);

  return (
    <div className="touch-controls" data-testid="touch-controls">
      <div ref={padRef} className="touch-pad" data-testid="touch-pad" aria-label="Steering pad" />
      <div className="touch-buttons">
        <ActionBtn input={input} action="spin" label="SPIN" testid="touch-spin" />
        <div className="touch-row">
          <ActionBtn input={input} action="sideLeft" label="◀ Q" testid="touch-q" />
          <ActionBtn input={input} action="sideRight" label="E ▶" testid="touch-e" />
        </div>
        <ActionBtn input={input} action="boost" label="BOOST" testid="touch-boost" />
      </div>
      <ActionBtn
        input={input}
        action="skyway"
        label="SKY"
        testid="touch-skyway"
        className="touch-skyway-btn"
      />
    </div>
  );
}

const ActionBtn = ({
  input,
  action,
  label,
  testid,
  className,
}: {
  input: InputApi;
  action: keyof KeyState;
  label: string;
  testid: string;
  className?: string;
}): React.JSX.Element => {
  const press = () => input.setAction('touch', action, true);
  const release = () => input.setAction('touch', action, false);
  return (
    <button
      type="button"
      className={`touch-btn${className ? ` ${className}` : ''}`}
      data-testid={testid}
      onPointerDown={press}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
    >
      {label}
    </button>
  );
};

