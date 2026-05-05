// Generates static social/PWA images. Pure Node — no browser dependency.
//
//   node scripts/gen-og.mjs
//
// Outputs:
//   public/og.png                (1200x630) for Open Graph / Twitter cards
//   public/apple-touch-icon.png  (180x180)  for iOS Home Screen
//
// The artwork is procedural: a synthwave gradient backdrop with horizon glow
// and a perspective grid. Good enough for previews — when you want the polished
// version, drop a hand-designed PNG into public/ with the same names.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, '..', 'public');
mkdirSync(PUBLIC, { recursive: true });

// -- Pure PNG encoder -------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
};

const encodePNG = (width, height, rgbaPixels) => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);   // bit depth
  ihdr.writeUInt8(6, 9);   // colour type RGBA
  ihdr.writeUInt8(0, 10);  // compression
  ihdr.writeUInt8(0, 11);  // filter
  ihdr.writeUInt8(0, 12);  // interlace
  const stride = width * 4;
  // Prepend filter byte (0 = None) per scanline
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgbaPixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

// -- Procedural artwork ------------------------------------------------------

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Return [r, g, b, a] tuples in 0..255 for the synthwave background. */
const sampleBg = (x, y, w, h) => {
  // Sky gradient: deep navy -> magenta near horizon (60% down).
  const ny = y / h;
  const horizon = 0.6;
  const skyT = clamp(ny / horizon, 0, 1);
  // Sky colors
  const top = [12, 4, 38];
  const mid = [76, 26, 122];
  const horiz = [255, 80, 180];
  const skyR = lerp(lerp(top[0], mid[0], skyT * 0.7), horiz[0], skyT * skyT);
  const skyG = lerp(lerp(top[1], mid[1], skyT * 0.7), horiz[1], skyT * skyT);
  const skyB = lerp(lerp(top[2], mid[2], skyT * 0.7), horiz[2], skyT * skyT);

  if (ny < horizon) {
    // Add a sun: a half-disc near the horizon center.
    const cx = w * 0.5, cy = h * horizon;
    const sunR = h * 0.3;
    const dx = x - cx, dy = y - cy;
    const dist = Math.hypot(dx, dy);
    if (dy < 0 && dist < sunR) {
      // Banded gradient
      const tBand = 1 - dist / sunR;
      const bandY = (cy - y) / sunR;
      const bands = Math.floor(bandY * 8);
      const banded = bands % 2 === 0 ? 1 : 0.5;
      const sunTop = [255, 220, 90];
      const sunBot = [255, 80, 200];
      const m = 1 - bandY;
      const sR = lerp(sunTop[0], sunBot[0], m) * banded;
      const sG = lerp(sunTop[1], sunBot[1], m) * banded;
      const sB = lerp(sunTop[2], sunBot[2], m) * banded;
      const k = smoothstep(0, 0.2, tBand);
      return [
        Math.round(lerp(skyR, sR, k)),
        Math.round(lerp(skyG, sG, k)),
        Math.round(lerp(skyB, sB, k)),
        255,
      ];
    }
    return [Math.round(skyR), Math.round(skyG), Math.round(skyB), 255];
  }

  // Ground: deep purple + perspective grid.
  const gT = (ny - horizon) / (1 - horizon);
  const groundTop = [40, 6, 70];
  const groundBot = [4, 0, 18];
  let gR = lerp(groundTop[0], groundBot[0], gT);
  let gG = lerp(groundTop[1], groundBot[1], gT);
  let gB = lerp(groundTop[2], groundBot[2], gT);

  // Horizontal grid lines: spaced by 1/(1-z) — closer near bottom.
  // Map gT in [0,1] to z in [1,0] (1 = horizon, 0 = camera).
  const z = 1 - gT;
  // Pick lines at fractional positions: line whenever fract(1/(z+0.05)) is small.
  const lineFreq = 6;
  const lineY = Math.abs(((1 / (z * 1.5 + 0.08)) * lineFreq) % 1 - 0.5);
  const hLine = smoothstep(0.06, 0.0, lineY);
  // Vertical grid lines: converge toward horizon center.
  const vx = (x - w * 0.5) / (w * 0.5); // -1..1
  const persp = vx / (z * 0.9 + 0.1);
  const vLineRaw = persp * 6;
  const vLine = smoothstep(0.06, 0.0, Math.abs((vLineRaw % 1) - 0.5));
  const grid = clamp(hLine + vLine, 0, 1) * (1 - gT * 0.6);
  const gridColor = [255, 90, 220];
  gR = lerp(gR, gridColor[0], grid * 0.85);
  gG = lerp(gG, gridColor[1], grid * 0.85);
  gB = lerp(gB, gridColor[2], grid * 0.85);

  return [Math.round(gR), Math.round(gG), Math.round(gB), 255];
};

// 5x7 monochrome bitmap font — uppercase letters + digits + a few symbols.
// Each glyph is a 5-wide, 7-tall pattern stored as 7 rows of 5 bits (MSB left).
const GLYPHS = {
  // Letters (subset we need)
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  I: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  ' ': [0, 0, 0, 0, 0, 0, 0],
};

const drawText = (pixels, w, h, text, x0, y0, scale, color) => {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const glyph = GLYPHS[ch] || GLYPHS[' '];
    for (let row = 0; row < 7; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col++) {
        if (bits & (1 << (4 - col))) {
          // Filled pixel — splat scale x scale.
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const px = x0 + (i * 6 + col) * scale + sx;
              const py = y0 + row * scale + sy;
              if (px >= 0 && px < w && py >= 0 && py < h) {
                const idx = (py * w + px) * 4;
                pixels[idx] = color[0];
                pixels[idx + 1] = color[1];
                pixels[idx + 2] = color[2];
                pixels[idx + 3] = 255;
              }
            }
          }
        }
      }
    }
  }
};

const renderImage = (w, h, withTitle) => {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = sampleBg(x, y, w, h);
      const i = (y * w + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  }
  if (withTitle) {
    // Draw a title across the upper third in pink-magenta.
    const text = 'NEON DRIFT';
    const scale = Math.floor(h / 14);
    const textW = text.length * 6 * scale - scale; // last glyph has no trailing space
    const x0 = Math.floor((w - textW) / 2);
    const y0 = Math.floor(h * 0.18);
    // Shadow
    drawText(buf, w, h, text, x0 + scale, y0 + scale, scale, [80, 0, 60]);
    drawText(buf, w, h, text, x0, y0, scale, [255, 220, 240]);
    // Subtitle
    const sub = 'ROOFTOP RACING';
    const sScale = Math.max(2, Math.floor(scale / 2));
    const subW = sub.length * 6 * sScale - sScale;
    drawText(
      buf,
      w,
      h,
      sub,
      Math.floor((w - subW) / 2),
      y0 + scale * 7 + scale,
      sScale,
      [255, 130, 220],
    );
  }
  return buf;
};

const renderIcon = (size) => {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2,
    cy = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) / cx;
      const dy = (y - cy) / cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const t = clamp(d, 0, 1);
      const r = Math.round(lerp(255, 30, t));
      const g = Math.round(lerp(80, 6, t));
      const b = Math.round(lerp(210, 70, t));
      const idx = (y * size + x) * 4;
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = 255;
    }
  }
  // White lightning-bolt-ish glyph: stroke a few diagonal lines.
  const stroke = (x0, y0, x1, y1, color, thickness) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = Math.round(lerp(x0, x1, t));
      const y = Math.round(lerp(y0, y1, t));
      for (let dy = -thickness; dy <= thickness; dy++) {
        for (let dx = -thickness; dx <= thickness; dx++) {
          const px = x + dx,
            py = y + dy;
          if (px >= 0 && px < size && py >= 0 && py < size) {
            const idx = (py * size + px) * 4;
            buf[idx] = color[0];
            buf[idx + 1] = color[1];
            buf[idx + 2] = color[2];
            buf[idx + 3] = 255;
          }
        }
      }
    }
  };
  const m = size / 180;
  stroke(110 * m, 30 * m, 70 * m, 95 * m, [255, 255, 255], 4 * m);
  stroke(70 * m, 95 * m, 100 * m, 95 * m, [255, 255, 255], 4 * m);
  stroke(100 * m, 95 * m, 70 * m, 150 * m, [255, 255, 255], 4 * m);
  return buf;
};

const ogPixels = renderImage(1200, 630, true);
writeFileSync(resolve(PUBLIC, 'og.png'), encodePNG(1200, 630, ogPixels));
console.log('wrote public/og.png (1200x630)');

const iconPixels = renderIcon(180);
writeFileSync(resolve(PUBLIC, 'apple-touch-icon.png'), encodePNG(180, 180, iconPixels));
console.log('wrote public/apple-touch-icon.png (180x180)');
