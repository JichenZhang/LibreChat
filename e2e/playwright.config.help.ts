import { defineConfig, devices } from '@playwright/test';

// The existing start-server/fake-model fixtures are started once by the scoped Garden canary.
export default defineConfig({
  testDir: './specs/mock',
  testMatch: 'garden-help.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  reporter: 'list',
  outputDir: '../../../output/implementation/garden-help/U2-browser-results',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:25483',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
