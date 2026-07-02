'use strict';

const path = require('path');
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 7830);
const DATA_DIR = path.join(__dirname, 'tests', '.tmp-data');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    serviceWorkers: 'block',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'node server.js',
    url: `http://127.0.0.1:${PORT}/api/status`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      ANI_WEB_HOST: '127.0.0.1',
      ANI_WEB_PORT: String(PORT),
      ANI_WEB_DATA_DIR: DATA_DIR,
      ANI_CLI_HIST_DIR: path.join(DATA_DIR, 'ani-cli'),
      ANI_CLI_DOWNLOAD_DIR: path.join(DATA_DIR, 'downloads'),
    },
  },
});
