// =============================================================================
// e2e/global-setup.ts
// =============================================================================
// Runs ONCE before the whole test suite:
//   1. Resets the demo tenant by re-running the seed (deletes + recreates).
//      This guarantees a known starting state — no test ordering dependencies.
//   2. Logs in as the seeded owner, captures the cookie + JWT.
//   3. Writes storage state to .artifacts/auth.json so every spec starts
//      authenticated.
//
// Run order: globalSetup → webServer boot → tests.
// =============================================================================

import { request as PWRequest, expect, FullConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ARTIFACTS = resolve(__dirname, '.artifacts');

const TEST_USER = {
  email: 'owner@mizan-investment.test',
  password: 'changeme',
};

export default async function globalSetup(config: FullConfig) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const apiBaseUrl = (config.metadata as any).apiBaseUrl as string;
  const webBaseUrl = (config.metadata as any).webBaseUrl as string;

  console.log('[e2e] resetting database to seed state…');
  resetDb();

  console.log(`[e2e] logging in at ${apiBaseUrl} …`);
  const ctx = await PWRequest.newContext({
    baseURL: apiBaseUrl,
    extraHTTPHeaders: { Origin: webBaseUrl },
  });

  const res = await ctx.post('/v1/auth/login', {
    data: { email: TEST_USER.email, password: TEST_USER.password },
  });
  expect(res.ok(), `login failed: ${res.status()} ${await res.text()}`).toBe(true);
  const body = await res.json();
  expect(body.accessToken, 'login response should include accessToken').toBeTruthy();

  // Persist storage state — both cookie (web) and access token (mobile/integration)
  await ctx.storageState({ path: resolve(ARTIFACTS, 'auth.json') });

  // Token also saved as a flat file so specs can use it for direct API calls
  // without parsing the storage state JSON.
  const fs = await import('node:fs');
  fs.writeFileSync(resolve(ARTIFACTS, 'access-token.txt'), body.accessToken, 'utf-8');

  await ctx.dispose();
  console.log('[e2e] global setup complete');
}

// -----------------------------------------------------------------------------
// DB reset — runs the seed via psql against the running compose stack.
// Override with E2E_RESET_CMD if you want to point this at staging or use
// a custom reset endpoint.
// -----------------------------------------------------------------------------

function resetDb(): void {
  const cmd = process.env.E2E_RESET_CMD;
  if (cmd) {
    execFileSync('sh', ['-c', cmd], { stdio: 'inherit' });
    return;
  }

  // Default: docker compose exec
  const dbUrl = process.env.E2E_DB_ADMIN_URL
    ?? 'postgres://app_admin:app_admin@localhost:5432/farm_erp';
  // We can't reliably run psql across all dev environments, so prefer
  // docker compose exec when available. Falls back to a local psql.
  try {
    execFileSync(
      'docker',
      [
        'compose', '-f', resolve(__dirname, '..', 'docker-compose.yml'),
        'exec', '-T', 'postgres',
        'psql', '-U', 'app_admin', '-d', 'farm_erp',
        '-v', 'ON_ERROR_STOP=1',
        '-f', '/app/prisma/seed-ethiopia.sql',
      ],
      { stdio: 'inherit' },
    );
  } catch {
    // Fall back to a local psql call
    execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-f', resolve(__dirname, '..', 'prisma', 'seed-ethiopia.sql')], {
      stdio: 'inherit',
    });
  }
}
