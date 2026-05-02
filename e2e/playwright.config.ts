// =============================================================================
// e2e/playwright.config.ts
// =============================================================================
// Targets the local stack from docker-compose.yml + a Vite dev server for
// the web app. Override the URLs via env to point at a staging deployment.
//
// Run:
//   npm i -D @playwright/test
//   npx playwright install chromium
//   npm run e2e            # (alias for `playwright test`)
//   npm run e2e -- --ui    # interactive
// =============================================================================

import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const WEB_BASE_URL = process.env.E2E_WEB_BASE_URL ?? 'http://localhost:5173';
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: resolve(__dirname, 'specs'),
  outputDir: resolve(__dirname, '.artifacts'),
  fullyParallel: false,            // shared Postgres/seed state — keep serial
  workers: 1,                      // ditto
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: resolve(__dirname, '.artifacts/html-report'), open: 'never' }],
  ],

  // Saved auth state (cookie + token) produced by global-setup.ts
  globalSetup: resolve(__dirname, 'global-setup.ts'),

  use: {
    baseURL: WEB_BASE_URL,
    storageState: resolve(__dirname, '.artifacts/auth.json'),
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    extraHTTPHeaders: {
      // Let the API/tileserver know which origin we're claiming for CORS
      Origin: WEB_BASE_URL,
    },
  },

  // Make the API URL discoverable inside specs
  metadata: { apiBaseUrl: API_BASE_URL, webBaseUrl: WEB_BASE_URL },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        // Permission for clipboard, camera (needed if testing photo capture later)
        permissions: ['geolocation'],
        // Important: PostGIS in CI sometimes needs a couple of seconds to warm up
        launchOptions: { slowMo: process.env.E2E_SLOWMO ? Number(process.env.E2E_SLOWMO) : 0 },
      },
    },
  ],

  // Boot the web dev server if not already running. The API/Postgres/etc.
  // we assume are up via `docker compose up -d`.
  webServer: process.env.E2E_NO_WEBSERVER ? undefined : {
    command: 'npm --workspace=apps/web run dev',
    url: WEB_BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
