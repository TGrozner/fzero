import { test, expect } from '@playwright/test';

test('menu → lobby → race shows HUD with power meter', async ({ page }) => {
  // Capture console errors so we can fail noisily on React warnings.
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
  });

  await page.goto('/?fast=1');

  // Menu visible.
  await expect(page.getByTestId('menu')).toBeVisible();

  // Type a pseudo and start.
  await page.getByTestId('pseudo-input').fill('Tester');
  await page.getByTestId('race-button').click();

  // Either we land in lobby or directly in race depending on server timing.
  // Wait for the race screen to appear (countdown then HUD).
  await expect(page.getByTestId('race-screen')).toBeVisible({ timeout: 30_000 });

  // The HUD should appear once first snapshot arrives.
  await expect(page.getByTestId('hud')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('power-meter')).toBeVisible();
  await expect(page.getByTestId('ko-meter')).toBeVisible();
  await expect(page.getByTestId('lap')).toContainText('Lap');

  // Press a few keys to send some inputs.
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(800);
  await page.keyboard.up('ArrowUp');

  // Position should be a number from 1..99.
  const position = await page.getByTestId('position').first().innerText();
  expect(position).toMatch(/\d/);

  // No console errors.
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
});

test('health endpoint serves ok', async ({ request }) => {
  const r = await request.get('http://127.0.0.1:8787/health');
  expect(r.status()).toBe(200);
  expect(await r.text()).toBe('ok');
});
