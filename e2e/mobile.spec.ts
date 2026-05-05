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

test('mobile control overlay renders all expected buttons during racing', async ({ page }) => {
  await startRace(page, `mobile-${Date.now().toString(36)}`);
  await expect(page.getByTestId('touch-controls')).toBeVisible({ timeout: 15_000 });
  for (const tid of [
    'touch-left',
    'touch-right',
    'touch-brake',
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

test('tap pause shows the pause overlay; tap leave on the overlay returns to menu', async ({ page }) => {
  await startRace(page, `mobile-pause-${Date.now().toString(36)}`);
  await expect(page.getByTestId('touch-pause')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('touch-pause').tap();
  await expect(page.getByTestId('pause')).toBeVisible();

  await page.getByTestId('pause-leave').tap();
  await expect(page.getByTestId('menu')).toBeVisible();
});

test('the touch leave button on the race HUD ends the race', async ({ page }) => {
  await startRace(page, `mobile-leave-${Date.now().toString(36)}`);
  await expect(page.getByTestId('touch-leave')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('touch-leave').tap();
  await expect(page.getByTestId('menu')).toBeVisible();
});

test('steer buttons are at least 64 px (thumb-friendly) and action buttons too', async ({ page }) => {
  await startRace(page, `mobile-size-${Date.now().toString(36)}`);
  await expect(page.getByTestId('touch-boost')).toBeVisible({ timeout: 15_000 });
  // Steer buttons are the dominant input and a touch larger.
  for (const tid of ['touch-left', 'touch-right']) {
    const box = await page.getByTestId(tid).boundingBox();
    expect(box, `${tid} bounding box`).toBeTruthy();
    expect(box!.width).toBeGreaterThanOrEqual(72);
    expect(box!.height).toBeGreaterThanOrEqual(72);
  }
  // Action buttons.
  for (const tid of ['touch-spin', 'touch-q', 'touch-e', 'touch-boost']) {
    const box = await page.getByTestId(tid).boundingBox();
    expect(box, `${tid} bounding box`).toBeTruthy();
    expect(box!.width).toBeGreaterThanOrEqual(64);
    expect(box!.height).toBeGreaterThanOrEqual(64);
  }
});
