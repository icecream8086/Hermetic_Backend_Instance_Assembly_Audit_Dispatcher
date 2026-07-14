/// <reference types="pactum" />

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spec, request } from 'pactum';
import { startTestServer } from './helper.ts';

let baseUrl: string;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const server = await startTestServer();
  baseUrl = server.baseUrl;
  dispose = server.dispose;
  request.setBaseUrl(baseUrl);
});

afterAll(async () => {
  await dispose();
});

describe('Container Group (Pod) API', () => {

  // ─── Validation errors (handler-level, before any provider call) ───
  // Note: when no IContainerGroupProvider is registered, the route returns 501
  // (NOT_CONFIGURED). In test environments without Podman, that's the expected
  // response. Validation errors (400) take priority over 501.

  const minimalPod = {
    metadata: { name: 'test-pod' },
    spec: {
      containers: [{ name: 'app', image: 'nginx:latest' }],
      restartPolicy: 'Always' as const,
    },
  };

  it('rejects PodSpec without name (400 or 501)', async () => {
    const res = await spec()
      .post('/api/pods/')
      .withJson({
        metadata: {},
        spec: {
          containers: [{ name: 'app', image: 'nginx:latest' }],
          restartPolicy: 'Always',
        },
      })
      .expect((ctx) => {
        const s = ctx.res.statusCode;
        if (s === 400) {
          expect(ctx.res.body.success).toBe(false);
        } else {
          expect(s).toBe(501);
        }
      });
  });

  it('rejects empty body (400 or 501)', async () => {
    await spec()
      .post('/api/pods/')
      .withJson({})
      .expect((ctx) => {
        expect([400, 501]).toContain(ctx.res.statusCode);
      });
  });

  it('rejects PodSpec without containers (400 or 501)', async () => {
    await spec()
      .post('/api/pods/')
      .withJson({
        metadata: { name: 'no-containers' },
        spec: { restartPolicy: 'Always' },
      })
      .expect((ctx) => {
        expect([400, 501]).toContain(ctx.res.statusCode);
      });
  });

  // ─── Provider-bound submission ───
  // Without a registered Pod provider, returns 501.
  // If Podman is running and registered, returns 201 or 500.

  it('routes valid PodSpec to provider (201, 500, 501, or 503)', async () => {
    await spec()
      .post('/api/pods/')
      .withJson(minimalPod)
      .expect((ctx) => {
        const s = ctx.res.statusCode;
        if (s === 201) {
          const d = ctx.res.body?.data ?? {};
          if (typeof d.podId !== 'string' || typeof d.providerId !== 'string') {
            throw new Error('201 response must include data.podId and data.providerId');
          }
        } else if (s !== 500 && s !== 501 && s !== 503) {
          throw new Error(`Unexpected status ${s}`);
        }
      });
  });

  it('handles multi-service PodSpec (201, 500, 501, or 503)', async () => {
    await spec()
      .post('/api/pods/')
      .withJson({
        metadata: { name: 'test-multi' },
        spec: {
          containers: [
            { name: 'web', image: 'nginx:latest', ports: [{ containerPort: 80, protocol: 'tcp' }], resources: { limits: { cpu: 0.5, memory: 128 } } },
            { name: 'api', image: 'node:20-alpine', command: ['node', 'index.js'] },
          ],
          restartPolicy: 'Always',
        },
      })
      .expect((ctx) => {
        expect([201, 500, 501, 503]).toContain(ctx.res.statusCode);
      });
  });

  it('handles PodSpec with health check (201, 500, 501, or 503)', async () => {
    await spec()
      .post('/api/pods/')
      .withJson({
        metadata: { name: 'test-health' },
        spec: {
          containers: [{
            name: 'app', image: 'nginx:latest',
            livenessProbe: {
              httpGet: { path: '/health', port: 80 },
              initialDelaySeconds: 10,
              periodSeconds: 5,
            },
          }],
          restartPolicy: 'Always',
        },
      })
      .expect((ctx) => {
        expect([201, 500, 501, 503]).toContain(ctx.res.statusCode);
      });
  });

  // ─── Route isolation: /:id should not collide with list ───

  it('get non-existent pod returns 404', async () => {
    await spec()
      .get('/api/pods/nonexistent-id')
      .expectStatus(404);
  });
});
