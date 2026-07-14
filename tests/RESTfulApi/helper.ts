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
  dataDir: string;
  dispose: () => Promise<void>;
}

export interface TestServerOpts {
  authz?: { enabled: boolean };
  /** Called with the temp dataDir after it's created but before the app initializes. */
  beforeApp?: (dataDir: string) => void;
}

/**
 * Start the Hono app locally with file-based storage.
 * Each call uses a unique temp directory so parallel test files don't collide.
 */
export async function startTestServer(opts?: TestServerOpts): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'hbi-test-'));

  if (opts?.beforeApp) opts.beforeApp(dataDir);

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
    authz: { enabled: opts?.authz?.enabled ?? false },
  });

  const instance = await createApp(config);
  await instance.seed(); // ensure seed data is available for tests

  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: instance.app.fetch, port: 0 },
      (info) => {
        const baseUrl = `http://localhost:${info.port}`;
        resolve({
          server,
          baseUrl,
          dataDir,
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
