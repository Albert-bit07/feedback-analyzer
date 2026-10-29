const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/browser',
  testMatch: '*.spec.cjs',
  workers: 1,
  retries: 0,
  timeout: 30000,
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:18787',
    httpCredentials: { username: 'analyst', password: 'browser-test-only-password' },
  },
  webServer: {
    command: 'node test/browser/server.cjs',
    url: 'http://127.0.0.1:18787/triage',
    reuseExistingServer: false,
    timeout: 60000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 },
  },
});
