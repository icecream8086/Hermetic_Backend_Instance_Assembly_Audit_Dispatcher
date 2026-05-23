/// <reference types="pactum" />

import { describe, it, beforeAll, afterAll } from 'vitest';
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

// ─── Bootstrap ───

beforeAll(async () => {
  await spec()
    .post('/api/users/register')
    .withJson({ email: 'rule-test@test.local', password: 'TestPass123', name: 'RuleTester', role: 'Admin' })
    .expectStatus(201)
    .stores('userId', 'data.user.id');
});

// ═══════════════════════════════════════
// Individual policy CRUD
// ═══════════════════════════════════════

describe('Permission rule CRUD', () => {
  it('POST creates a policy with allow effect', async () => {
    await spec()
      .post('/api/permissions/policies')
      .withJson({
        name: 'Allow login',
        effect: 'allow',
        actions: ['login'],
        resource: 'session',
        userId: '$S{userId}',
        priority: 50,
      })
      .expectStatus(201)
      .expectJson('data.name', 'Allow login')
      .expectJson('data.effect', 'allow')
      .expectJson('data.priority', 50)
      .expectJson('data.enabled', true)
      .stores('policyId', 'data.id');
  });

  it('POST creates a deny policy', async () => {
    await spec()
      .post('/api/permissions/policies')
      .withJson({
        name: 'Block delete',
        effect: 'deny',
        actions: ['delete'],
        resource: '*',
        priority: 99,
      })
      .expectStatus(201)
      .expectJson('data.effect', 'deny')
      .stores('denyPolicyId', 'data.id');
  });

  it('GET lists all policies', async () => {
    await spec()
      .get('/api/permissions/policies')
      .expectStatus(200);
  });

  it('GET by id returns the policy', async () => {
    await spec()
      .get('/api/permissions/policies/$S{policyId}')
      .expectStatus(200)
      .expectJson('data.id', '$S{policyId}');
  });

  it('PUT updates policy name and priority', async () => {
    await spec()
      .put('/api/permissions/policies/$S{policyId}')
      .withJson({ name: 'Allow login v2', priority: 60 })
      .expectStatus(200)
      .expectJson('data.name', 'Allow login v2')
      .expectJson('data.priority', 60);
  });

  it('PUT disables the policy', async () => {
    await spec()
      .put('/api/permissions/policies/$S{policyId}')
      .withJson({ enabled: false })
      .expectStatus(200)
      .expectJson('data.enabled', false);
  });

  it('GET 404 for non-existent policy', async () => {
    await spec()
      .get('/api/permissions/policies/nonexistent')
      .expectStatus(404);
  });

  it('DELETE removes the policy', async () => {
    await spec()
      .delete('/api/permissions/policies/$S{denyPolicyId}')
      .expectStatus(200);

    await spec()
      .get('/api/permissions/policies/$S{denyPolicyId}')
      .expectStatus(404);
  });

  it('POST validation error for missing name', async () => {
    await spec()
      .post('/api/permissions/policies')
      .withJson({ effect: 'allow' })
      .expectStatus(400)
      .expectJson('error.code', 'VALIDATION_ERROR');
  });
});
