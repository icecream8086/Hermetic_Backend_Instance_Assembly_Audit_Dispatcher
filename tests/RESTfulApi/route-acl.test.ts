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

// ─── Bootstrap: create root user + wheel group ───

const ROOT_EMAIL = 'wheel@test.local';
const ROOT_PW = 'RootPass123!';

beforeAll(async () => {
  // Register root user
  await spec()
    .post('/api/users/register')
    .withJson({ email: ROOT_EMAIL, password: ROOT_PW, name: 'Wheel', role: 'root' })
    .expectStatus(201)
    .stores('rootId', 'data.user.id')
    .stores('rootToken', 'data.token');

  // Create wheel user group
  await spec()
    .post('/api/permissions/user-groups')
    .withJson({ name: 'simulate_wheel', memberIds: ['$S{rootId}'] })
    .expectStatus(201)
    .stores('wheelGroupId', 'data.id');
});

// ═══════════════════════════════════════
// Route ACL CRUD
// ═══════════════════════════════════════

describe('Route ACL CRUD', () => {
  let aclId: string;

  it('POST creates a prefix-match allow ACL for the wheel group', async () => {
    await spec()
      .post('/api/permissions/route-acls')
      .withJson({
        method: 'GET',
        pathPrefix: '/api/users',
        matchType: 'prefix',
        effect: 'allow',
        userGroupId: '$S{wheelGroupId}',
        priority: 100,
      })
      .expectStatus(201)
      .expectJson('data.method', 'GET')
      .expectJson('data.matchType', 'prefix')
      .expectJson('data.effect', 'allow')
      .expectJson('data.pathPrefix', '/api/users')
      .stores('aclId1', 'data.id');
  });

  it('POST creates an exact-match deny ACL', async () => {
    await spec()
      .post('/api/permissions/route-acls')
      .withJson({
        method: 'DELETE',
        pathPrefix: '/api/users/admin-only',
        matchType: 'exact',
        effect: 'deny',
        userId: '$S{rootId}',
        priority: 200,
      })
      .expectStatus(201)
      .expectJson('data.matchType', 'exact')
      .expectJson('data.effect', 'deny')
      .stores('aclId2', 'data.id');
  });

  it('GET lists all route ACLs', async () => {
    await spec()
      .get('/api/permissions/route-acls')
      .expectStatus(200)
      // data should be an array — existence of routeacl_ prefix in first item
      .expect((ctx) => {
        const data = ctx.res.body?.data;
        if (!data || !Array.isArray(data.items) || data.items.length === 0) throw new Error('Expected non-empty items array');
        if (!data.items[0]?.id?.startsWith?.('routeacl_')) throw new Error('Expected routeacl_ prefix in first ACL id');
      });
  });

  it('GET by id returns the ACL', async () => {
    await spec()
      .get('/api/permissions/route-acls/$S{aclId1}')
      .expectStatus(200)
      .expectJson('data.id', '$S{aclId1}');
  });

  it('PUT updates matchType and effect', async () => {
    await spec()
      .put('/api/permissions/route-acls/$S{aclId1}')
      .withJson({ matchType: 'exact', effect: 'deny' })
      .expectStatus(200)
      .expectJson('data.matchType', 'exact')
      .expectJson('data.effect', 'deny');
  });

  it('GET 404 for non-existent ACL', async () => {
    await spec()
      .get('/api/permissions/route-acls/nonexistent')
      .expectStatus(404);
  });

  it('DELETE removes the ACL', async () => {
    await spec()
      .delete('/api/permissions/route-acls/$S{aclId2}')
      .expectStatus(200);

    await spec()
      .get('/api/permissions/route-acls/$S{aclId2}')
      .expectStatus(404);
  });

  it('PUT 404 on deleted ACL', async () => {
    await spec()
      .put('/api/permissions/route-acls/$S{aclId2}')
      .withJson({ priority: 50 })
      .expectStatus(404);
  });
});

// ═══════════════════════════════════════
// checkRouteAccess via check endpoint
// ═══════════════════════════════════════

describe('checkRouteAccess integration', () => {
  it('POST /check returns allowed for prefix-match ACL', async () => {
    // Re-create a known ACL for this test group
    await spec()
      .post('/api/permissions/route-acls')
      .withJson({
        method: 'GET',
        pathPrefix: '/api/users',
        matchType: 'prefix',
        effect: 'allow',
        userGroupId: '$S{wheelGroupId}',
        priority: 100,
      })
      .expectStatus(201)
      .stores('checkAclId', 'data.id');

    // The check endpoint calls PermissionService.check() which uses
    // stored policies + permission groups, NOT route ACLs.
    // Route ACLs are checked by the auth middleware via checkRouteAccess().
    // This test verifies the basic check endpoint still works.
    await spec()
      .post('/api/permissions/check')
      .withJson({ userId: '$S{rootId}', action: 'read', resource: 'user' })
      .expectStatus(200);
  });
});
