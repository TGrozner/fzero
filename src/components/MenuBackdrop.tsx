import { useEffect, useRef } from 'react';
import type { ShipClass } from '../../shared/constants.ts';

type Props = {
  color: string;
  cls: ShipClass;
};

const CLASS_BODY = {
  speed: { wMul: 0.85, lMul: 1.15 },
  tank: { wMul: 1.18, lMul: 0.92 },
  balanced: { wMul: 1, lMul: 1 },
} as const;

/**
 * Full-screen menu backdrop. Renders behind the menu card:
 *   • a slow synthwave star field with parallax-shifted stars,
 *   • two slow-scrolling pillar silhouettes for depth,
 *   • a rotating preview of the player's chosen ship in the user's colour.
 *
 * Pure rAF loop tied to the canvas's lifecycle. Cheap — one full-screen
 * gradient paint + ~80 stars + a few hundred polygon points per frame.
 */
export function MenuBackdrop({ color, cls }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let raf = 0;
    let stopped = false;
    const stars: { x: number; y: number; r: number; tw: number }[] = [];
    let s = 1337;
    const rng = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    for (let i = 0; i < 90; i++) {
      stars.push({ x: rng(), y: rng() * 0.55, r: 0.4 + rng() * 1.6, tw: rng() * Math.PI * 2 });
    }
    const pillars: { w: number; h: number; layer: number }[] = [];
    for (let i = 0; i < 26; i++) {
      pillars.push({ w: 18 + rng() * 40, h: 14 + rng() * 60, layer: i % 2 });
    }
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const onResize = () => resize();
    window.addEventListener('resize', onResize);
    const draw = (t: number) => {
      if (stopped) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      // Sky gradient.
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#0a0524');
      sky.addColorStop(0.6, '#1f0a44');
      sky.addColorStop(0.9, '#3a1758');
      sky.addColorStop(1, '#04010a');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h);
      // Stars.
      for (const star of stars) {
        const sx = ((star.x + t * 0.00002) % 1) * w;
        const sy = star.y * h;
        const twinkle = 0.5 + 0.5 * Math.sin(t * 0.0025 + star.tw);
        ctx.fillStyle = `rgba(255,255,255,${0.25 + twinkle * 0.55})`;
        ctx.beginPath();
        ctx.arc(sx, sy, star.r, 0, Math.PI * 2);
        ctx.fill();
      }
      // Two pillar layers near the horizon.
      const horizon = h * 0.62;
      for (const layer of [0, 1] as const) {
        const speed = layer === 0 ? 0.012 : 0.028;
        const offset = (t * speed) % w;
        const fill =
          layer === 0 ? 'rgba(40, 14, 70, 0.85)' : 'rgba(80, 28, 110, 0.88)';
        ctx.fillStyle = fill;
        let x = -offset;
        ctx.beginPath();
        ctx.moveTo(x, horizon);
        for (let rep = 0; rep < 3; rep++) {
          for (const p of pillars) {
            if (p.layer !== layer) continue;
            ctx.lineTo(x, horizon - p.h);
            ctx.lineTo(x + p.w, horizon - p.h);
            x += p.w;
            if (x > w + offset) break;
          }
          if (x > w + offset) break;
        }
        ctx.lineTo(x, horizon);
        ctx.closePath();
        ctx.fill();
      }
      // Horizon glow stripe.
      ctx.fillStyle = 'rgba(255, 58, 209, 0.55)';
      ctx.fillRect(0, horizon - 2, w, 3);
      // Ground gradient + faint horizontal lines.
      const ground = ctx.createLinearGradient(0, horizon, 0, h);
      ground.addColorStop(0, '#0c0530');
      ground.addColorStop(1, '#03000d');
      ctx.fillStyle = ground;
      ctx.fillRect(0, horizon, w, h - horizon);
      ctx.strokeStyle = 'rgba(255, 58, 209, 0.25)';
      ctx.lineWidth = 1;
      for (let i = 1; i <= 8; i++) {
        const yy = horizon + (h - horizon) * Math.pow(i / 8, 1.6);
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(w, yy);
        ctx.stroke();
      }
      // Rotating ship preview centred on the lower-left third.
      const cx = w * 0.22;
      const cy = h * 0.62;
      const baseSize = Math.min(w, h) * 0.075;
      const rot = t * 0.0008;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      const shape = CLASS_BODY[cls] ?? CLASS_BODY.balanced;
      const bw = baseSize * shape.wMul;
      const bl = baseSize * shape.lMul;
      // Shadow.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.ellipse(0, bl * 0.35, bw * 0.9, bw * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowColor = color;
      ctx.shadowBlur = 18;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, -bl * 0.95);
      ctx.lineTo(bw * 0.75, bl * 0.65);
      ctx.lineTo(bw * 0.32, bl * 0.4);
      ctx.lineTo(0, bl * 0.55);
      ctx.lineTo(-bw * 0.32, bl * 0.4);
      ctx.lineTo(-bw * 0.75, bl * 0.65);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.beginPath();
      ctx.moveTo(0, -bl * 0.55);
      ctx.lineTo(bw * 0.18, -bl * 0.05);
      ctx.lineTo(-bw * 0.18, -bl * 0.05);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [color, cls]);

  return <canvas ref={canvasRef} className="menu-backdrop" data-testid="menu-backdrop" />;
}
