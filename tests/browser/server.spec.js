import { test, expect } from '@playwright/test';
import { instance } from '../helpers.js';

test('real operator console manages users and apps, displays limits, and signs out', async ({
  page,
}) => {
  const i = await instance();
  try {
    await page.goto(`${i.origin}/login`);
    await page.getByLabel('Email', { exact: true }).fill(i.user.email);
    await page.getByLabel('Password', { exact: true }).fill(i.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(`${i.origin}/workspace`);
    await expect(page.locator('.storage-card')).toContainText('256 MiB');
    await page.getByRole('link', { name: 'People', exact: true }).click();
    await page.getByRole('button', { name: 'Add person' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Real test user');
    await page.getByLabel('Email', { exact: true }).fill('member@example.test');
    await page.getByLabel('Initial password').fill(i.password);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#editor')).not.toBeVisible();
    const row = page.getByRole('row').filter({ hasText: 'member@example.test' });
    await row.getByRole('button', { name: 'Suspend' }).click();
    await expect(row).toContainText('Suspended');
    await page.getByRole('link', { name: 'Applications', exact: true }).click();
    await page.getByRole('button', { name: 'Add application' }).click();
    await page.getByLabel('Application name').fill('Real test client');
    await page.getByLabel('Exact redirect URI').fill('http://localhost:3000/callback');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.data-table')).toContainText('Real test client');
    await page.getByRole('link', { name: 'Audit log', exact: true }).click();
    await expect(page.locator('.data-table')).toContainText('user / suspended');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(`${i.origin}/login`);
    expect(await page.evaluate(async () => (await fetch('/api/v1/status')).status)).toBe(401);
  } finally {
    await i.stop();
  }
});
