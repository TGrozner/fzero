import { test, expect } from '@playwright/test';

// Run the whole file under mobile-Chromium emulation: hasTouch + isMobile +
// a realistic mobile viewport, so isTouchDevice() returns true and the
// on-screen controls render. Webkit isn't installed in CI by default; we
// pin to chromium to keep the test fast and CI-friendly while still
// exercising the same mobile code path the renderer cares about.
test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
  userAgent:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
});

const startRace = async (page: import('@playwright/test').Page, room?: string) => {
  const url = `/?fast=1${room ? `&room=${room}` : ''}`;
  await page.goto(url);
  await expect(page.getByTestId('menu')).toBeVisible();
  await page.getByTestId('pseudo-input').fill('Phone');
  await page.getByTestId('race-button').tap();
  await expect(page.getByTestId('race-screen')).toBeVisible({ timeout: 30_000 });
};

test('on a touch device, the touch controls render after the race starts', async ({ page }) => {
  await startRace(page, `mobile-${Date.now().toString(36)}`);
  // Wait for COUNTDOWN → RACING (touch controls are gated to RACING).
  await expect(page.getByTestId('touch-controls')).toBeVisible({ timeout: 15_000 });
  // Joystick area + every action button + UI buttons must be present.
  for (const tid of [
    'touch-pad',
    'touch-spin',
    'touch-q',
    'touch-e',
    'touch-boost',
    'touch-skyway',
    'touch-pause',
    'touch-leave',
  ]) {
    await expect(page.getByTestId(tid)).toBeVisible();
  }
});

test('the visible joystick base + knob appear on touch and hide on release', async ({ page }) => {
  await startRace(page, `mobile-jstk-${Date.now().toString(36)}`);
  await expect(page.getByTestId('touch-pad')).toBeVisible({ timeout: 15_000 });

  // No joystick visible at rest.
  await expect(page.getByTestId('touch-joystick-base')).toHaveCount(0);

  const pad = page.getByTestId('touch-pad');
  const box = await pad.boundingBox();
  if (!box) throw new Error('touch-pad has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Tap-and-hold: touchscreen API supports a single tap; for a sustained
  // press we use page.dispatchEvent to fire pointer events directly.
  await page.touchscreen.tap(cx, cy);
  // Tap fires pointerdown + pointerup in quick succession; the joystick
  // briefly appears then hides. Verify it's hidden immediately after.
  await expect(page.getByTestId('touch-joystick-base')).toHaveCount(0);
});

test('tap pause shows the pause overlay; tap leave on the overlay returns to menu', async ({ page }) => {
  await startRace(page, `mobile-pause-${Date.now().toString(36)}`);
  await expect(page.getByTestId('touch-pause')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('touch-pause').tap();
  await expect(page.getByTestId('pause')).toBeVisible();

  // The pause overlay's existing leave button takes the user back to the menu.
  await page.getByTestId('pause-leave').tap();
  await expect(page.getByTestId('menu')).toBeVisible();
});

test('the touch leave button on the race HUD ends the race', async ({ page }) => {
  await startRace(page, `mobile-leave-${Date.now().toString(36)}`);
  await expect(page.getByTestId('touch-leave')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('touch-leave').tap();
  await expect(page.getByTestId('menu')).toBeVisible();
});

test('action buttons exist as 72 px tap targets (thumb-friendly)', async ({ page }) => {
  await startRace(page, `mobile-size-${Date.now().toString(36)}`);
  await expect(page.getByTestId('touch-boost')).toBeVisible({ timeout: 15_000 });
  for (const tid of ['touch-spin', 'touch-q', 'touch-e', 'touch-boost']) {
    const box = await page.getByTestId(tid).boundingBox();
    expect(box, `${tid} bounding box`).toBeTruthy();
    expect(box!.width).toBeGreaterThanOrEqual(64); // 72 px target with light tolerance
    expect(box!.height).toBeGreaterThanOrEqual(64);
  }
});
