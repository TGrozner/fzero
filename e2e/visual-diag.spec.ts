/**
 * Diagnostic visual spec — drives the ship through several poses and dumps
 * screenshots into playwright-report/visual/ for a human (or LLM) to inspect.
 * Runs only when explicitly invoked: `npx playwright test e2e/visual-diag.spec.ts`.
 */
import { test, type Page } from '@playwright/test';

const SCREENSHOT_DIR = 'playwright-report/visual';

const uniqueRoom = (label: string): string =>
  `diag-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const enterRace = async (page: Page, label: string): Promise<void> => {
  const room = uniqueRoom(label);
  await page.goto(`/?fast=1&room=${room}`);
  await page.getByTestId('pseudo-input').fill('Diag');
  await page.getByTestId('race-button').click();
  await page.getByTestId('race-screen').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId('hud').waitFor({ state: 'visible', timeout: 15_000 });
};

test('shoot: multiple in-race angles', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await enterRace(page, 'angles');

  // Countdown (~3s) — fast=1 starts lobby in 2s, then 3-2-1-GO.
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/diag-1-countdown.png` });

  // Wait for the race to actually start.
  await page.waitForTimeout(2400);

  // 2. Just after GO — driver still on grid, can see start line.
  await page.screenshot({ path: `${SCREENSHOT_DIR}/diag-2-post-go.png` });

  // Drive forward + drift right to follow the oval — keep the ship alive.
  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/diag-3-curving-right.png` });

  // Boost briefly.
  await page.keyboard.down('ShiftLeft');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/diag-4-boost.png` });
  await page.keyboard.up('ShiftLeft');

  // Switch to gentle steering — capture a bank moment.
  await page.keyboard.up('KeyD');
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/diag-5-bank-left.png` });
  await page.keyboard.up('KeyA');
  await page.keyboard.up('KeyW');
});
