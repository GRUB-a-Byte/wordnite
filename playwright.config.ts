import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs entirely locally: the dev-only WebSocket relay (scripts/relay.mjs) stands in for
 * Supabase Realtime, so no credentials are needed. The host browser is still the referee.
 */
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3100);
const RELAY_PORT = Number(process.env.E2E_RELAY_PORT ?? 8788);

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node scripts/relay.mjs',
      env: { RELAY_PORT: String(RELAY_PORT) },
      port: RELAY_PORT,
      reuseExistingServer: false,
      stdout: 'ignore',
    },
    {
      // E2E_PROD=1 runs the suite against a production build (next build && next start).
      command: process.env.E2E_PROD
        ? `npx next build && npx next start -p ${APP_PORT}`
        : `npx next dev -p ${APP_PORT}`,
      url: `http://localhost:${APP_PORT}`,
      env: {
        NEXT_PUBLIC_REALTIME_TRANSPORT: 'local',
        NEXT_PUBLIC_LOCAL_RELAY_URL: `ws://localhost:${RELAY_PORT}`,
        NEXT_TELEMETRY_DISABLED: '1',
      },
      timeout: 180_000,
      reuseExistingServer: false,
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
