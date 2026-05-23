/// <reference types="pactum" />

import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { loadConfig } from '../../src/config/env.ts';
import { createApp } from '../../src/core/app.ts';

export interface TestServer {
  server: ServerType;
  baseUrl: string;
  dispose: () => Promise<void>;
}

/**
 * Start the Hono app locally with file-based storage.
 * Each call uses a unique temp directory so parallel test files don't collide.
 */
export async function startTestServer(): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'hbi-test-'));

  const config = loadConfig({
    storage: {
      stateBackend: 'file',
      queryBackend: 'none',
      blobBackend: 'none',
      connections: { filePath: dataDir },
    },
    scheduler: {
      backend: 'worker',
      intervalMs: 60000,
      batchSize: 0,
    },
    authz: { enabled: false },
  });

  const instance = await createApp(config);

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
            rmSync(dataDir, { recursive: true, force: true });
          },
        });
      },
    );
    server.on('error', reject);
  });
}
