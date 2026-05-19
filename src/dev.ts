/**
 * Local Node.js dev server — bypasses workerd entirely.
 *
 * Workerd crashes on Windows Insider builds (libuv UV_HANDLE_CLOSING bug).
 * Run with: npm run dev
 *
 * Uses `@hono/node-server` to serve the Hono app on http://localhost:3000.
 * All DO / KV / D1 / R2 bindings are stubbed with file-based adapters.
 */

import { serve } from '@hono/node-server';
import { loadConfig } from './config/env.ts';
import { createApp } from './core/app.ts';

const config = loadConfig({
  storage: {
    stateBackend: 'file',
    queryBackend: 'none',
    blobBackend: 'none',
    connections: { filePath: '.data' },
  },
  scheduler: {
    backend: 'worker',
    intervalMs: 60000,
    batchSize: 0,
  },
});

const instance = createApp(config);

serve({ fetch: instance.app.fetch, port: config.server.port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[dev] Server listening on http://localhost:${info.port}`);
});

process.on('SIGINT', () => {
  instance.dispose().then(() => process.exit(0));
});
