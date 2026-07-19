import { test } from '@playwright/test';

test('map screenshot', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load', timeout: 20_000 });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'test-results/map-screenshot.png', fullPage: false });
});
