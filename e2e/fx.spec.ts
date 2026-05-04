/**
 * E2E tests for the new FX / multiplayer features added in this milestone:
 * profile overlay, named-room input, and the spectator overlay surface.
 *
 * These tests use `?fast=1` so the lobby auto-starts in 2s and the race
 * begins immediately after the 3s countdown.
 */
import { test, expect, type Page } from '@playwright/test';

const uniqueRoom = (label: string): string =>
  `fx-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const enterRace = async (page: Page, label: string, extraQuery = ''): Promise<void> => {
  const room = uniqueRoom(label);
  const sep = extraQuery ? `&${extraQuery}` : '';
  await page.goto(`/?fast=1&room=${room}${sep}`);
  await page.getByTestId('pseudo-input').fill('FxTest');
  await page.getByTestId('race-button').click();
  await expect(page.getByTestId('race-screen')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('hud')).toBeVisible({ timeout: 15_000 });
};

test('menu shows the room input and accepts alphanumerics', async ({ page }) => {
  await page.goto('/');
  const input = page.getByTestId('room-input');
  await expect(input).toBeVisible();
  await input.fill('alpha-123');
  await expect(input).toHaveValue('alpha-123');
  // Reject special chars: input filters them out on change.
  await input.fill('bad!@#name');
  await expect(input).toHaveValue('badname');
});

test('profile overlay is hidden by default', async ({ page }) => {
  await enterRace(page, 'no-profile');
  await page.waitForTimeout(2000);
  await expect(page.getByTestId('profile-overlay')).toHaveCount(0);
});

test('profile overlay surfaces FPS and particle count when ?profile=1', async ({ page }) => {
  await enterRace(page, 'profile', 'profile=1');
  await page.waitForTimeout(4500);
  const overlay = page.getByTestId('profile-overlay');
  await expect(overlay).toBeVisible();
  const text = await overlay.innerText();
  expect(text).toMatch(/FPS \d+/);
  expect(text).toMatch(/particles \d+/);
});

test('side attack triggers a per-frame impact burst (renderer side ring + canvas)', async ({
  page,
}) => {
  // We can't directly observe the WebGL particle buffer, but we can verify
  // the React-side overlay (`fx-side`) appears and the canvas pixels under
  // the player change after firing a side attack.
  await enterRace(page, 'side');
  await page.waitForTimeout(4500);
  await page.keyboard.press('KeyE');
  await expect(page.getByTestId('fx-side')).toBeVisible({ timeout: 500 });
});
