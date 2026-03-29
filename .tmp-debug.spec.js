const { test } = require('@playwright/test');

test('debug home', async ({ page }) => {
  page.on('console', msg => console.log('CONSOLE', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('PAGEERROR', err.stack || err.message));
  page.on('requestfailed', req => console.log('REQFAIL', req.url(), req.failure()?.errorText));
  await page.goto('http://localhost:3210');
  await page.waitForTimeout(1500);
  console.log('BODY', JSON.stringify(await page.locator('body').innerText()));
});
