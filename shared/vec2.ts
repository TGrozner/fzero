export type Vec2 = { readonly x: number; readonly y: number };

export const v2 = (x: number, y: number): Vec2 => ({ x, y });
export const ZERO: Vec2 = v2(0, 0);

export const add = (a: Vec2, b: Vec2): Vec2 => v2(a.x + b.x, a.y + b.y);
export const sub = (a: Vec2, b: Vec2): Vec2 => v2(a.x - b.x, a.y - b.y);
export const scale = (a: Vec2, s: number): Vec2 => v2(a.x * s, a.y * s);
export const neg = (a: Vec2): Vec2 => v2(-a.x, -a.y);
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
/** 2D cross product (scalar): a.x*b.y - a.y*b.x. */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const lengthSq = (a: Vec2): number => a.x * a.x + a.y * a.y;
export const length = (a: Vec2): number => Math.sqrt(lengthSq(a));
export const distanceSq = (a: Vec2, b: Vec2): number => lengthSq(sub(a, b));
export const distance = (a: Vec2, b: Vec2): number => Math.sqrt(distanceSq(a, b));

export const normalize = (a: Vec2): Vec2 => {
  const len = length(a);
  if (len === 0) return ZERO;
  return v2(a.x / len, a.y / len);
};

export const rotate = (a: Vec2, angle: number): Vec2 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return v2(a.x * c - a.y * s, a.x * s + a.y * c);
};

export const fromAngle = (angle: number, len = 1): Vec2 =>
  v2(Math.cos(angle) * len, Math.sin(angle) * len);

export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);

export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 =>
  v2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);

/** Reflect vector v around the unit normal n (n must be normalized). */
export const reflect = (v: Vec2, n: Vec2): Vec2 => {
  const d = dot(v, n);
  return sub(v, scale(n, 2 * d));
};

/** Returns the perpendicular vector (rotated +90 deg). */
export const perp = (a: Vec2): Vec2 => v2(0 - a.y, a.x);

export const clamp = (x: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, x));

/** Wrap angle to (-PI, PI]. */
export const wrapAngle = (a: number): number => {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r <= -Math.PI) r += Math.PI * 2;
  return r;
};

/** Linear interpolation of an angle (shortest direction). */
export const lerpAngle = (a: number, b: number, t: number): number => {
  const diff = wrapAngle(b - a);
  return a + diff * t;
};
