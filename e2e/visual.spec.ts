/**
 * Visual smoke tests: drive the client through menu → race, then sample the
 * canvas at known positions to verify obvious render properties.
 *
 * These tests are NOT pixel-perfect snapshots (canvas content varies with
 * snapshot timing); they assert structural properties:
 *   - The canvas is not empty in the foreground (track visible).
 *   - The player's ship appears near the lower-center of the screen.
 *   - The HUD reads its meters from snapshot data.
 *   - No console errors are emitted during a 10-second race.
 *
 * Screenshots are saved to playwright-report/ for human inspection.
 */
import { test, expect, type Page } from '@playwright/test';

const SCREENSHOT_DIR = 'playwright-report/visual';

type RGBA = { r: number; g: number; b: number; a: number };

/** Each test gets its own server room so concurrent races don't collide. */
const uniqueRoom = (label: string): string =>
  `vis-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const samplePixel = async (page: Page, xFrac: number, yFrac: number): Promise<RGBA> => {
  return await page.evaluate(
    ({ xf, yf }) => {
      const c = document.querySelector('canvas') as HTMLCanvasElement | null;
      if (!c) return { r: 0, g: 0, b: 0, a: 0 };
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return { r: 0, g: 0, b: 0, a: 0 };
      const x = Math.floor(c.width * xf);
      const y = Math.floor(c.height * yf);
      const data = ctx.getImageData(x, y, 1, 1).data;
      return {
        r: data[0] ?? 0,
        g: data[1] ?? 0,
        b: data[2] ?? 0,
        a: data[3] ?? 0,
      };
    },
    { xf: xFrac, yf: yFrac },
  );
};

const isBackgroundLike = (px: RGBA): boolean => {
  // Background gradient is dark purple-blue, all channels < ~50.
  return px.r < 60 && px.g < 60 && px.b < 80;
};

const enterRace = async (page: Page, label: string): Promise<void> => {
  const room = uniqueRoom(label);
  await page.goto(`/?fast=1&room=${room}`);
  await page.getByTestId('pseudo-input').fill('VisualTest');
  await page.getByTestId('race-button').click();
  await expect(page.getByTestId('race-screen')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('hud')).toBeVisible({ timeout: 15_000 });
};

test('render has a visible HUD and a non-empty foreground after countdown', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await enterRace(page, 'foreground');
  await page.waitForTimeout(4500);

  // The player ship is anchored near the lower part of the screen — sample a
  // vertical strip at center-X and assert at least one pixel is non-background.
  const ys = [0.65, 0.7, 0.75, 0.8, 0.85];
  let foundShipPixel = false;
  for (const y of ys) {
    const px = await samplePixel(page, 0.5, y);
    if (!isBackgroundLike(px)) {
      foundShipPixel = true;
      break;
    }
  }
  expect(foundShipPixel, 'expected ship/track pixel near center bottom').toBe(true);

  const rows = [0.6, 0.7, 0.8, 0.9];
  const cols = [0.3, 0.5, 0.7];
  let nonBackground = 0;
  for (const r of rows) {
    for (const c of cols) {
      const px = await samplePixel(page, c, r);
      if (!isBackgroundLike(px)) nonBackground++;
    }
  }
  // Track is a strip in perspective: only the segments curving through our
  // sample columns will show. Require at least a few non-background hits.
  expect(nonBackground).toBeGreaterThanOrEqual(2);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/race-after-countdown.png`, fullPage: false });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('HUD meters update from server snapshots', async ({ page }) => {
  await enterRace(page, 'hud');
  await page.waitForTimeout(5000);

  const powerWidth = await page.getByTestId('power-meter').locator('.fill').evaluate((el) => {
    return (el as HTMLElement).style.width;
  });
  expect(powerWidth).toMatch(/^\d+(\.\d+)?%$/);

  const t1 = await page.getByTestId('time').innerText();
  await page.waitForTimeout(1500);
  const t2 = await page.getByTestId('time').innerText();
  expect(t1).not.toBe(t2);

  const racers = parseInt(await page.getByTestId('racers-left').innerText(), 10);
  expect(racers).toBeGreaterThan(70);
});

test('countdown overlay shows numbers, not just GO', async ({ page }) => {
  const room = uniqueRoom('countdown');
  await page.goto(`/?fast=1&room=${room}`);
  await page.getByTestId('pseudo-input').fill('CountdownTest');
  await page.getByTestId('race-button').click();
  await expect(page.getByTestId('race-screen')).toBeVisible({ timeout: 30_000 });

  let sawNumber = false;
  for (let i = 0; i < 40; i++) {
    const overlay = page.getByTestId('countdown');
    if ((await overlay.count()) === 0) break;
    const txt = (await overlay.innerText()).trim();
    if (/^[123]$/.test(txt)) {
      sawNumber = true;
      break;
    }
    await page.waitForTimeout(100);
  }
  expect(sawNumber, 'expected countdown to show 1, 2, or 3 (not just GO)').toBe(true);
});

test('WASD steering produces input messages without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await enterRace(page, 'wasd');
  await page.waitForTimeout(4000);

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(300);
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(200);
  await page.keyboard.up('KeyA');
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(200);
  await page.keyboard.up('KeyD');
  await page.keyboard.down('KeyQ');
  await page.waitForTimeout(150);
  await page.keyboard.up('KeyQ');
  await page.keyboard.down('KeyE');
  await page.waitForTimeout(150);
  await page.keyboard.up('KeyE');
  await page.keyboard.up('KeyW');

  expect(errors, errors.join('\n')).toEqual([]);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/race-after-inputs.png`, fullPage: false });
});

test('attack key presses surface visual FX overlays', async ({ page }) => {
  await enterRace(page, 'fx');
  await page.waitForTimeout(4000);

  // Spin attack (Enter) → fx-spin briefly visible.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('fx-spin')).toBeVisible({ timeout: 500 });

  // Side attack (Q) → fx-side visible briefly.
  await page.keyboard.press('KeyQ');
  await expect(page.getByTestId('fx-side')).toBeVisible({ timeout: 500 });
});

test('track surface renders as a solid purple region in the foreground', async ({ page }) => {
  await enterRace(page, 'surface');
  // Wait until the race actually starts — fast=1 lobby is 2s + 3s countdown.
  await page.waitForTimeout(5500);

  // The continuous track polygon uses #2c1a5a (~44,26,90) with the alternating
  // ribbon shading on top. Sample a grid of points in the lower-half of the
  // screen and assert we hit purple pixels across the visible track region.
  const samples = await Promise.all(
    [
      [0.45, 0.55],
      [0.5, 0.58],
      [0.55, 0.6],
      [0.6, 0.62],
      [0.65, 0.65],
      [0.7, 0.68],
      [0.75, 0.7],
      [0.8, 0.72],
    ].map(([x, y]) => samplePixel(page, x as number, y as number)),
  );
  const purpleHits = samples.filter(
    (s) => s.r >= 20 && s.r <= 110 && s.g >= 5 && s.g <= 70 && s.b >= 55 && s.b <= 150,
  ).length;
  expect(
    purpleHits,
    `expected at least 1 purple track pixel (got ${samples.map((s) => `(${s.r},${s.g},${s.b})`).join(' ')})`,
  ).toBeGreaterThanOrEqual(1);
});

test('track surface stays visible directly under the player while accelerating', async ({
  page,
}) => {
  // Regression: drawTrack used to skip ribs that straddled the near plane,
  // leaving a hole between the camera and the closest fully-visible rib.
  // The player ship sits ~70-80% down the screen — those pixels MUST be the
  // dark purple track surface (#2c1a5a) every frame while moving forward.
  await enterRace(page, 'surface-under-player');
  await page.waitForTimeout(5500);

  const isTrackPurple = (px: RGBA): boolean =>
    px.r >= 20 && px.r <= 110 && px.g >= 5 && px.g <= 70 && px.b >= 55 && px.b <= 150;

  // Sample under the player at a row of points across the bottom of the
  // screen, before, during, and after a forward burst.
  const sampleUnderPlayer = async (): Promise<number> => {
    const xs = [0.4, 0.45, 0.5, 0.55, 0.6];
    const ys = [0.7, 0.78, 0.86];
    let hits = 0;
    for (const x of xs) {
      for (const y of ys) {
        const px = await samplePixel(page, x, y);
        if (isTrackPurple(px)) hits++;
      }
    }
    return hits;
  };

  const beforeHits = await sampleUnderPlayer();
  expect(beforeHits, 'expected track pixels under the player at race start').toBeGreaterThanOrEqual(
    6,
  );

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(400);
  const midHits = await sampleUnderPlayer();
  await page.waitForTimeout(400);
  const afterHits = await sampleUnderPlayer();
  await page.keyboard.up('KeyW');

  expect(midHits, 'track must stay under the player mid-acceleration').toBeGreaterThanOrEqual(6);
  expect(afterHits, 'track must stay under the player after sustained acceleration').toBeGreaterThanOrEqual(
    6,
  );
});

test('spin attack visibly rotates the player ship over its duration', async ({ page }) => {
  // Regression: triggering Enter only flashed a CSS overlay; the ship itself
  // didn't rotate. RenderState.triggerLocalSpin now drives a 420ms rotation
  // — sample the same canvas region at two moments in the spin and assert
  // the pixels differ (the ship has moved/rotated).
  await enterRace(page, 'spin');
  await page.waitForTimeout(5500);

  // Sample a generous block around the player ship pivot. The ship sits
  // roughly 65-70% of the way down the screen depending on speed; the body
  // is ~22px so we cover a wide enough region to catch the rotation.
  const sampleBlock = async (): Promise<RGBA[]> => {
    const out: RGBA[] = [];
    for (const dx of [-0.04, -0.02, 0, 0.02, 0.04]) {
      for (const dy of [-0.06, -0.03, 0, 0.03, 0.06]) {
        out.push(await samplePixel(page, 0.5 + dx, 0.7 + dy));
      }
    }
    return out;
  };

  // Trigger the spin and let one frame settle.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(60);
  const earlyFrame = await sampleBlock();

  // Wait for ~50% of the spin (~210ms after press → ~150ms more).
  await page.waitForTimeout(150);
  const midFrame = await sampleBlock();

  const differing = earlyFrame.filter((a, i) => {
    const b = midFrame[i] as RGBA;
    return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) > 8;
  }).length;
  expect(
    differing,
    `expected pixels around the player to change between early and mid spin (got ${differing})`,
  ).toBeGreaterThanOrEqual(2);
});

test('60fps target: at least 200 frames in 5 seconds of racing', async ({ page }) => {
  await enterRace(page, 'fps');
  await page.waitForTimeout(4000);

  const frames = await page.evaluate(async () => {
    return await new Promise<number>((resolve) => {
      let count = 0;
      const start = performance.now();
      const tick = () => {
        count++;
        if (performance.now() - start >= 5000) {
          resolve(count);
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
  });
  expect(frames).toBeGreaterThanOrEqual(200);
});
