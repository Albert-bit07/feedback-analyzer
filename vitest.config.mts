import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
  plugins: [cloudflareTest({
    remoteBindings: false,
    miniflare: { bindings: { DASHBOARD_PASSWORD: 'test-only-password' } },
    wrangler: { configPath: './wrangler.jsonc' },
  })],
  test: { include: ['test/**/*.spec.ts'] },
});
