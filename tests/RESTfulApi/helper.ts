/// <reference types="pactum" />

import { rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { loadConfig } from '../../src/config/env.ts';
import { createApp } from '../../src/core/app.ts';

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../.data-test');

export interface TestServer {
  server: ServerType;
  baseUrl: string;
  dispose: () => Promise<void>;
}

/**
 * Start the Hono app locally with file-based storage.
 * Cleans `.data-test` before starting so each run starts fresh.
 * Call in vitest's `beforeAll` / dispose in `afterAll`.
 */
export async function startTestServer(): Promise<TestServer> {
  // Wipe state from previous runs to guarantee isolation
  if (existsSync(DATA_DIR)) {
    rmSync(DATA_DIR, { recursive: true, force: true });
  }

  const config = loadConfig({
    storage: {
      stateBackend: 'file',
      queryBackend: 'none',
      blobBackend: 'none',
      connections: { filePath: DATA_DIR },
    },
    scheduler: {
      backend: 'worker',
      intervalMs: 60000,
      batchSize: 0,
    },
  });

  const instance = createApp(config);

  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: instance.app.fetch, port: 0 },
      (info) => {
        const baseUrl = `http://localhost:${info.port}`;
        resolve({
          server,
          baseUrl,
          dispose: async () => {
            await instance.dispose();
            await new Promise<void>((r) => server.close(() => r()));
          },
        });
      },
    );
    server.on('error', reject);
  });
}
