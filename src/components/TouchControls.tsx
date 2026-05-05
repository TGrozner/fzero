import { useEffect, useRef, useState } from 'react';
import type { InputApi, KeyState } from '../hooks/useKeyboard.ts';
import {
  computeStick,
  NEUTRAL_STICK,
  RADIUS_PX,
  type StickState,
} from './joystickMath.ts';

type Props = {
  input: InputApi;
  onPause: () => void;
  onLeave: () => void;
};

const haptic = (ms = 8): void => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // navigator.vibrate not supported on iOS or older browsers — noop.
  }
};

/**
 * Touch / pointer control overlay. Renders ONLY on touch-primary devices
 * (see isTouchDevice). Layout, with safe-area insets respected:
 *
 *   ┌──────────────────────────────────────────┐
 *   │ [⏸] [⨯]                          [SKY]   │
 *   │                                          │
 *   │                                          │
 *   │                                  [SPIN]  │
 *   │                                  [Q] [E] │
 *   │   (joystick area —               [BOOST] │
 *   │    bottom 60 % of                        │
 *   │    the left half)                        │
 *   └──────────────────────────────────────────┘
 *
 * The joystick is "floating" — anchored at the touch origin, the knob tracks
 * the finger up to RADIUS_PX past the deadzone. A semi-transparent base ring
 * + knob render only while the gesture is active.
 *
 * Each button writes via `setAction` on press and clears on release/cancel,
 * with a short haptic pulse on press where supported.
 */
export function TouchControls({ input, onPause, onLeave }: Props) {
  const padRef = useRef<HTMLDivElement | null>(null);
  const activePointerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  // Anchor position in CSS pixels (relative to the viewport) — used to
  // position the visible joystick base + knob.
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [stick, setStick] = useState<StickState>(NEUTRAL_STICK);

  useEffect(() => {
    const pad = padRef.current;
    if (!pad) return;
    const applyStick = (next: StickState) => {
      input.setAction('touch', 'up', next.up);
      input.setAction('touch', 'down', next.down);
      input.setAction('touch', 'left', next.left);
      input.setAction('touch', 'right', next.right);
      setStick(next);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (activePointerRef.current !== null) return;
      activePointerRef.current = e.pointerId;
      startRef.current = { x: e.clientX, y: e.clientY };
      setAnchor({ x: e.clientX, y: e.clientY });
      pad.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return;
      const start = startRef.current;
      if (!start) return;
      applyStick(computeStick(e.clientX - start.x, e.clientY - start.y));
    };
    const release = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return;
      activePointerRef.current = null;
      startRef.current = null;
      setAnchor(null);
      applyStick(NEUTRAL_STICK);
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
      {/* Joystick gesture surface — covers the whole bottom-left area. */}
      <div
        ref={padRef}
        className="touch-pad"
        data-testid="touch-pad"
        aria-label="Steering joystick"
        role="presentation"
      />
      {/* Visible joystick base + knob (rendered on top of the pad surface). */}
      {anchor && (
        <>
          <div
            className="touch-joystick-base"
            data-testid="touch-joystick-base"
            style={{
              left: anchor.x - RADIUS_PX,
              top: anchor.y - RADIUS_PX,
              width: RADIUS_PX * 2,
              height: RADIUS_PX * 2,
            }}
          />
          <div
            className="touch-joystick-knob"
            data-testid="touch-joystick-knob"
            data-active={stick.active ? 'true' : 'false'}
            style={{
              left: anchor.x + stick.knob.x - 22,
              top: anchor.y + stick.knob.y - 22,
            }}
          />
        </>
      )}

      {/* Top-left UI buttons: pause, leave. Always tap-fire (no hold state). */}
      <div className="touch-ui-row">
        <button
          type="button"
          className="touch-ui-btn"
          data-testid="touch-pause"
          aria-label="Pause"
          onPointerDown={(e) => {
            e.preventDefault();
            haptic(6);
            onPause();
          }}
        >
          ⏸
        </button>
        <button
          type="button"
          className="touch-ui-btn"
          data-testid="touch-leave"
          aria-label="Leave race"
          onPointerDown={(e) => {
            e.preventDefault();
            haptic(6);
            onLeave();
          }}
        >
          ⨯
        </button>
      </div>

      {/* Bottom-right action buttons: SPIN above, Q+E middle, BOOST below.
          Each is hold-to-fire (clears on pointerup / pointercancel / leave). */}
      <div className="touch-buttons">
        <ActionBtn input={input} action="spin" label="SPIN" testid="touch-spin" />
        <div className="touch-row">
          <ActionBtn input={input} action="sideLeft" label="◀ Q" testid="touch-q" />
          <ActionBtn input={input} action="sideRight" label="E ▶" testid="touch-e" />
        </div>
        <ActionBtn input={input} action="boost" label="BOOST" testid="touch-boost" />
      </div>

      {/* Top-right Skyway. Server gates the actual effect on the KO meter
          but we keep the button always visible so muscle memory stays put. */}
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
  const press = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    haptic(6);
    input.setAction('touch', action, true);
  };
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
