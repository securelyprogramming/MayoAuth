import { test, expect } from '@playwright/test';
test('landing page is beta, usable on mobile, and links to honest edition details', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.beta-tag')).toHaveText('BETA');
  await expect(page.locator('h1')).toContainText('Your identity.');
  await expect(page.locator('#editions')).toContainText('NOT YET AVAILABLE');
  await page.screenshot({ path: 'test-results/landing-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('link', { name: 'Take it for a spin' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/landing-mobile.png', fullPage: true });
  await page.getByRole('link', { name: 'Take it for a spin' }).click();
  await expect(page.locator('h1')).toContainText('Identity, under your control.');
  expect(errors).toEqual([]);
});
test('demo supports lifecycle, persistence, audit export, connectors and safe rendering', async ({
  page,
}) => {
  const external = [];
  page.on('request', (req) => {
    if (
      new URL(req.url()).origin !==
      new URL(page.url() === 'about:blank' ? 'http://127.0.0.1:18787' : page.url()).origin
    )
      external.push(req.url());
  });
  await page.goto('/demo#users');
  await page.getByRole('button', { name: 'Add person' }).click();
  await page.getByLabel('Name', { exact: true }).fill('<img src=x onerror=alert(1)>');
  await page.getByLabel('Sample email').fill('taylor@example.test');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.data-table')).toContainText('<img src=x onerror=alert(1)>');
  expect(await page.locator('.data-table img').count()).toBe(0);
  await page.reload();
  await expect(page.locator('.data-table')).toContainText('taylor@example.test');
  const row = page.getByRole('row').filter({ hasText: 'taylor@example.test' });
  await row.getByRole('button', { name: 'Suspend' }).click();
  await expect(row).toContainText('Suspended');
  await page.getByRole('link', { name: 'Applications', exact: true }).click();
  await page.getByRole('button', { name: 'Add application' }).click();
  await page.getByLabel('Application name').fill('Sample app');
  await page.getByLabel('Exact redirect URI').fill('http://localhost:3000/callback');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.data-table')).toContainText('Sample app');
  await page.getByRole('link', { name: 'OIDC connectors', exact: true }).click();
  await page.getByRole('button', { name: 'Add connector' }).click();
  await page.getByLabel('Provider name').fill('Sample provider');
  await page.getByLabel('OIDC issuer').fill('https://identity.example.test');
  await page.getByLabel('Client ID').fill('sample-id');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.connector-grid')).toContainText('Sample provider');
  await page.getByRole('link', { name: 'Audit log', exact: true }).click();
  await expect(page.locator('.data-table')).toContainText('user suspended');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('mayoauth-sample-audit.json');
  expect(external).toEqual([]);
});
test('demo enforces 20-user boundary, rejects real addresses, and stays within mobile viewport', async ({
  page,
}) => {
  await page.goto('/demo#users');
  await page.getByRole('button', { name: 'Add person' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Example');
  await page.getByLabel('Sample email').fill('person@gmail.com');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#form-error')).toContainText('@example.test');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  for (let n = 3; n < 20; n++) {
    await page.getByRole('button', { name: 'Add person' }).click();
    await page.getByLabel('Name', { exact: true }).fill(`Sample ${n}`);
    await page.getByLabel('Sample email').fill(`sample${n}@example.test`);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#editor')).not.toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Add person' })).toBeDisabled();
  await expect(page.locator('.table-count')).toContainText('20 / 20');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/demo-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await page.screenshot({ path: 'test-results/demo-desktop.png', fullPage: true });
});
