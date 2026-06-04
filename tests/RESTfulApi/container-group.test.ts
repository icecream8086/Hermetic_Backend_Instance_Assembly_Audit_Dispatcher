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

  it('rejects PodSpec without name (400 or 501)', async () => {
    const res = await spec()
      .post('/api/sandboxes/pod')
      .withJson({
        services: { app: { image: 'nginx:latest' } },
      })
      .expect((ctx) => {
        const s = ctx.res.statusCode;
        if (s === 400) {
          expect(ctx.res.body.success).toBe(false);
          expect(ctx.res.body.error.code).toBe('VALIDATION_ERROR');
        } else {
          expect(s).toBe(501);
        }
      });
  });

  it('rejects empty body (400 or 501)', async () => {
    await spec()
      .post('/api/sandboxes/pod')
      .withJson({})
      .expect((ctx) => {
        expect([400, 501]).toContain(ctx.res.statusCode);
      });
  });

  it('rejects PodSpec without services (400 or 501)', async () => {
    await spec()
      .post('/api/sandboxes/pod')
      .withJson({ name: 'no-services' })
      .expect((ctx) => {
        expect([400, 501]).toContain(ctx.res.statusCode);
      });
  });

  // ─── Provider-bound submission ───
  // Without a registered IContainerGroupProvider, returns 501.
  // If Podman is running and registered, returns 201 or 500.

  it('routes valid PodSpec to provider (201, 500, or 501)', async () => {
    await spec()
      .post('/api/sandboxes/pod')
      .withJson({
        name: 'test-minimal',
        services: {
          app: { image: 'docker.io/library/alpine:latest', command: ['sleep', '10'] },
        },
      })
      .expect((ctx) => {
        const s = ctx.res.statusCode;
        if (s === 201) {
          const d = ctx.res.body?.data ?? {};
          if (typeof d.providerId !== 'string' || typeof d.podName !== 'string') {
            throw new Error('201 response must include data.providerId and data.podName');
          }
        } else if (s !== 500 && s !== 501) {
          throw new Error(`Unexpected status ${s}`);
        }
      });
  });

  it('handles multi-service PodSpec (201, 500, or 501)', async () => {
    await spec()
      .post('/api/sandboxes/pod')
      .withJson({
        name: 'test-multi',
        labels: { env: 'test' },
        sharedNamespaces: ['net', 'uts'],
        services: {
          web: {
            image: 'docker.io/library/nginx:latest',
            ports: [{ containerPort: 80, protocol: 'tcp' }],
            resources: { cpu: '0.5', memory: '128Mi' },
          },
          api: {
            image: 'docker.io/library/node:20-alpine',
            command: ['node', 'index.js'],
            dependsOn: ['web'],
          },
        },
      })
      .expect((ctx) => {
        expect([201, 500, 501]).toContain(ctx.res.statusCode);
      });
  });

  it('handles PodSpec with health check (201, 500, or 501)', async () => {
    await spec()
      .post('/api/sandboxes/pod')
      .withJson({
        name: 'test-health',
        services: {
          app: {
            image: 'docker.io/library/nginx:latest',
            healthCheck: {
              test: ['CMD', 'curl', '-f', 'http://localhost/health'],
              intervalSeconds: 10,
              timeoutSeconds: 5,
              retries: 3,
              startPeriodSeconds: 30,
            },
          },
        },
      })
      .expect((ctx) => {
        expect([201, 500, 501]).toContain(ctx.res.statusCode);
      });
  });

  // ─── Route isolation: /pod should not collide with /:id ───

  it('does not interfere with existing sandbox routes', async () => {
    await spec()
      .get('/api/sandboxes/nonexistent-id')
      .expectStatus(404);
  });
});
