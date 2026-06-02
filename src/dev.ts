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
import { createRegionId } from './core/region/types.ts';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env file manually — tsx doesn't auto-load it
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envPath = resolve(__dirname, '..', '.env');
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
} catch { /* .env not found — use env vars / defaults */ }

const config = loadConfig({
  provider: {
    container: 'podman',
    region: createRegionId('local'),
    accounts: [],
    defaultAccount: 'default',
    dns: 'stub',
    metrics: 'stub',
  },
  storage: {
    stateBackend: 'file',
    queryBackend: 'none',
    blobBackend: 'file',
    connections: { filePath: '.data' },
  },
  scheduler: {
    backend: 'worker',
    intervalMs: 60000,
    batchSize: 0,
  },
});

const instance = await createApp(config);

serve({ fetch: instance.app.fetch, port: config.server.port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] INFO: [dev] Server listening on http://localhost:${info.port}`);
});

process.on('SIGINT', () => {
  instance.dispose().then(() => process.exit(0));
});
