// Playwright config. Two modes:
//  - local: starts `node app/server.js` with TEST_MODE=1 (BUG_MODE passes through) on PORT (default 3100)
//  - external: set BASE_URL (e.g. docker compose service http://web:3000) and DB_PATH to the shared db file
const path = require('node:path');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0'; // browsers installed inside node_modules (local mode)
const { defineConfig } = require('@playwright/test');

const external = !!process.env.BASE_URL;
const PORT = process.env.PORT || '3100';
const baseURL = process.env.BASE_URL || `http://localhost:${PORT}`;
process.env.BASE_URL_RESOLVED = baseURL;
// local mode: the config starts the server, so it owns DB_PATH. External mode must pass the web's DB_PATH explicitly
// (otherwise TC-NFR-04 would inspect a stale local file and could pass falsely).
if (!external) process.env.DB_PATH ??= path.resolve(__dirname, 'data', 'test.db.json');

module.exports = defineConfig({
  testDir: 'tests',
  globalSetup: require.resolve('./tests/global-setup.js'),
  workers: 1, // one shared server state; every TC starts with POST /api/test/reset
  timeout: 180_000,
  expect: { timeout: 5_000 },
  reporter: [['list'], ['json', { outputFile: process.env.PW_JSON || 'test-results/results.json' }]],
  use: { baseURL, locale: 'th-TH', timezoneId: 'Asia/Bangkok', acceptDownloads: true, screenshot: 'only-on-failure' },
  webServer: external ? undefined : {
    command: 'node app/server.js',
    url: `${baseURL}/api/health`,
    timeout: 30_000,
    env: { ...process.env, TEST_MODE: '1', PORT }, // BUG_MODE and DB_PATH pass through from the environment
  },
});
