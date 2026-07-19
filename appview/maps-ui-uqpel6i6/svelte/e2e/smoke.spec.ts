import { test, expect } from '@playwright/test';

test('root page loads', async ({ page }) => {
  await page.goto('/');
  await expect(page).not.toHaveTitle('');
  // Worker responds with HTML (not JSON 404)
  const ct = await page.evaluate(() => document.contentType);
  expect(ct).toBe('text/html');
});

test('_app/meta responds', async ({ page }) => {
  const res = await page.request.get('/_app/meta');
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json.nanoid).toBe('uqpel6i6');
  expect(json.uiType).toBe('appview');
});

test('KAMI canvas present', async ({ page }) => {
  await page.goto('/');
  // Wait for bootstrapMap to run (canvas element rendered)
  const canvas = page.locator('#kami-map-canvas');
  await expect(canvas).toBeAttached({ timeout: 10_000 });
});

test('KAMI renders or shows graceful error', async ({ page }) => {
  await page.goto('/');
  // Either mapReady=true (canvas renders) or mapError is shown — both are valid
  await page.waitForFunction(() => {
    const err = document.querySelector('[data-testid="map-error"]');
    const canvas = document.getElementById('kami-map-canvas');
    return err !== null || (canvas && canvas instanceof HTMLCanvasElement);
  }, { timeout: 15_000 });
});
