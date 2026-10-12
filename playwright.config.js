import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.MAYOAUTH_TEST_URL || 'http://127.0.0.1:18787',
    headless: true,
    viewport: { width: 1440, height: 1000 },
  },
  webServer: process.env.MAYOAUTH_TEST_URL
    ? undefined
    : {
        command: 'node bin/mayoauth.js serve --website-only --port 18787',
        url: 'http://127.0.0.1:18787/health',
        reuseExistingServer: !process.env.CI,
      },
  reporter: 'list',
});
