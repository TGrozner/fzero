import { useEffect } from 'react';
import type { InputApi, KeyState } from '../hooks/useKeyboard.ts';

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
 * Tap-fire actions latch their input bit for at least one server tick (10 Hz
 * = 100 ms) so the server reliably observes a quick tap. With a sub-100 ms
 * tap on a touchscreen the keyboard's natural keydown/keyup gap of ~150 ms
 * is gone — without latching, fast taps slip through the cracks of the next
 * 100 ms input snapshot and the action never fires server-side.
 */
const TAP_FIRE_MIN_HOLD_MS = 150;
const TAP_FIRE_ACTIONS = new Set<keyof KeyState>(['spin', 'sideLeft', 'sideRight', 'skyway']);

/**
 * Touch / pointer control overlay. Renders ONLY on touch-primary devices.
 * Two-thumb layout — each thumb owns its own corner of the screen and never
 * has to leave its cluster to reach a button it cares about:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ [⏸] [⨯]                                      │
 *   │                                              │
 *   │                                              │
 *   │                                              │
 *   │                                              │
 *   │   [Q] [SPIN]                  [E] [SKY]      │
 *   │   [◀]                         [▶] [BOOST]    │
 *   └──────────────────────────────────────────────┘
 *
 * Left thumb owns LEFT-side actions (turn-L + bump-L), and SPIN sits
 * naturally to the right of Q so a thumb roll up-and-over fires it. Right
 * thumb owns RIGHT-side actions (turn-R + bump-R), with SKY in the same
 * "top-right of cluster" slot symmetrical to SPIN, and BOOST adjacent to ▶
 * so the most-used hold button is always under the resting thumb. Throttle
 * is auto-engaged for the whole racing lifetime so the player just steers.
 *
 * Button categories:
 *   - HOLD-TO-FIRE (left, right, boost) clear the bit on release.
 *   - TAP-FIRE (spin, sideLeft, sideRight, skyway) latch the bit for 150 ms
 *     so the next 10 Hz server input snapshot reliably observes the press.
 */
export function TouchControls({ input, onPause, onLeave }: Props) {
  // Auto-throttle on for the entire mounted lifetime. Race.tsx unmounts this
  // overlay outside of active racing (paused / KO / spectator) so we never
  // pin "up=true" while in the wrong phase.
  useEffect(() => {
    input.setAction('touch', 'up', true);
    return () => {
      input.setAction('touch', 'up', false);
    };
  }, [input]);

  return (
    <div className="touch-controls" data-testid="touch-controls">
      {/* Top-left UI buttons: pause + leave. Tap-fire callbacks. */}
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

      {/* Bottom-left cluster — left thumb. Top row = bumps (Q) + spin (tap-
          fire utility); bottom row = the big primary turn-L button. */}
      <div className="touch-cluster touch-cluster-left">
        <div className="touch-cluster-row">
          <ActionBtn input={input} action="sideLeft" label="Q" testid="touch-q" />
          <ActionBtn input={input} action="spin" label="SPIN" testid="touch-spin" />
        </div>
        <div className="touch-cluster-row">
          <ActionBtn
            input={input}
            action="left"
            label="◀"
            testid="touch-left"
            className="touch-btn-steer"
          />
        </div>
      </div>

      {/* Bottom-right cluster — right thumb. Top row = bump-R (E) + skyway;
          bottom row = the big primary turn-R + boost (held adjacent so a
          single thumb covers both during a boosted turn). */}
      <div className="touch-cluster touch-cluster-right">
        <div className="touch-cluster-row">
          <ActionBtn input={input} action="sideRight" label="E" testid="touch-e" />
          <ActionBtn input={input} action="skyway" label="SKY" testid="touch-skyway" />
        </div>
        <div className="touch-cluster-row">
          <ActionBtn
            input={input}
            action="right"
            label="▶"
            testid="touch-right"
            className="touch-btn-steer"
          />
          <ActionBtn
            input={input}
            action="boost"
            label="BOOST"
            testid="touch-boost"
            className="touch-btn-boost"
          />
        </div>
      </div>
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
  const isTapFire = TAP_FIRE_ACTIONS.has(action);
  const press = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    haptic(6);
    input.setAction('touch', action, true);
  };
  const release = () => {
    if (isTapFire) {
      // Defer the release so a quick tap survives the next server input
      // snapshot. setTimeout is fine here — at ≥ 150 ms minimum hold the
      // server sees the bit on its next 100 ms tick.
      window.setTimeout(() => {
        input.setAction('touch', action, false);
      }, TAP_FIRE_MIN_HOLD_MS);
    } else {
      input.setAction('touch', action, false);
    }
  };
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
