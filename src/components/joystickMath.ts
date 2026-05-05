/**
 * Pure helpers for the touch joystick. Kept out of the React component so
 * the math is unit-testable without spinning up jsdom + pointer events.
 *
 * The joystick is a "floating" type: the centre is wherever the user first
 * touched, and the knob tracks the finger relative to that anchor up to the
 * configured radius.
 */

export type StickState = {
  /** Should the throttle key fire. */
  up: boolean;
  /** Should the brake key fire. */
  down: boolean;
  /** Should the steer-left key fire. */
  left: boolean;
  /** Should the steer-right key fire. */
  right: boolean;
  /**
   * Pixel offset of the knob from the anchor, clamped to RADIUS_PX. Used by
   * the renderer to draw the visible knob on top of the base ring.
   */
  knob: { x: number; y: number };
  /** True if the gesture has crossed the dead-zone radius. */
  active: boolean;
};

/**
 * Distance below this (in pixels) is treated as "no input" — prevents the
 * thumb's microtremor from triggering a steer/throttle.
 */
export const DEAD_ZONE_PX = 14;

/**
 * The visible "full deflection" radius. Beyond this we clamp the knob; further
 * movement past the radius doesn't change anything.
 */
export const RADIUS_PX = 72;

/**
 * Threshold (fraction of the unit circle, 0..1) past which steering is
 * considered engaged. A bit lower than `THROTTLE_THRESHOLD` so diagonal
 * inputs ("up + right") feel natural — you're nudging right while pushing up.
 */
export const STEER_THRESHOLD = 0.32;

/**
 * Throttle threshold. Lower than steer because pushing forward on the stick
 * is the most common intent and we want it responsive.
 */
export const THROTTLE_THRESHOLD = 0.32;

/**
 * Brake threshold. Higher than throttle so a gentle backward nudge doesn't
 * brake when the player meant to steer through a tight downward corner.
 * Pulling firmly down (>= 0.6 of full deflection) clearly intends a brake.
 */
export const BRAKE_THRESHOLD = 0.6;

/**
 * Compute the per-action booleans + visual knob offset from a raw
 * (deltaX, deltaY) gesture relative to the floating anchor.
 *
 * dx > 0 = thumb moved right; dy > 0 = thumb moved DOWN (screen-space, not
 * world). All thresholds are tuned so the joystick feels precise without
 * fighting the user.
 */
export const computeStick = (dx: number, dy: number): StickState => {
  const len = Math.hypot(dx, dy);
  if (len < DEAD_ZONE_PX) {
    return {
      up: false,
      down: false,
      left: false,
      right: false,
      knob: { x: dx, y: dy },
      active: false,
    };
  }
  const clampedLen = Math.min(len, RADIUS_PX);
  const knob = {
    x: (dx / len) * clampedLen,
    y: (dy / len) * clampedLen,
  };
  // Normalise to the unit-circle so thresholds are scale-invariant — pulling
  // 30 px to the right with a 60 px gesture is the same intent as pulling
  // 60 px right with a 120 px gesture.
  const nx = dx / len;
  const ny = dy / len;
  return {
    up: ny < -THROTTLE_THRESHOLD,
    down: ny > BRAKE_THRESHOLD,
    left: nx < -STEER_THRESHOLD,
    right: nx > STEER_THRESHOLD,
    knob,
    active: true,
  };
};

/** Default "all false" state — used when the gesture is released. */
export const NEUTRAL_STICK: StickState = {
  up: false,
  down: false,
  left: false,
  right: false,
  knob: { x: 0, y: 0 },
  active: false,
};
