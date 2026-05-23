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
    .withJson({ email: 'grp-test@test.local', password: 'TestPass123', name: 'GrpTester', role: 'Admin' })
    .expectStatus(201)
    .stores('userId', 'data.user.id');
});

// ═══════════════════════════════════════
// User groups CRUD
// ═══════════════════════════════════════

describe('User group CRUD', () => {
  it('POST creates a user group', async () => {
    await spec()
      .post('/api/permissions/user-groups')
      .withJson({ name: 'admins', memberIds: ['$S{userId}'] })
      .expectStatus(201)
      .expectJson('data.name', 'admins')
      .expectJson('data.memberIds[0]', '$S{userId}')
      .stores('userGroupId', 'data.id');
  });

  it('POST creates another group', async () => {
    await spec()
      .post('/api/permissions/user-groups')
      .withJson({ name: 'viewers', memberIds: [] })
      .expectStatus(201)
      .stores('viewerGroupId', 'data.id');
  });

  it('GET lists all user groups', async () => {
    await spec()
      .get('/api/permissions/user-groups')
      .expectStatus(200);
  });

  it('GET by id returns the group', async () => {
    await spec()
      .get('/api/permissions/user-groups/$S{userGroupId}')
      .expectStatus(200)
      .expectJson('data.name', 'admins');
  });

  it('PUT updates group name and members', async () => {
    await spec()
      .put('/api/permissions/user-groups/$S{userGroupId}')
      .withJson({ name: 'super-admins', memberIds: ['$S{userId}'] })
      .expectStatus(200)
      .expectJson('data.name', 'super-admins');
  });

  it('DELETE removes a group', async () => {
    await spec()
      .delete('/api/permissions/user-groups/$S{viewerGroupId}')
      .expectStatus(200);

    await spec()
      .get('/api/permissions/user-groups/$S{viewerGroupId}')
      .expectStatus(404);
  });

  it('GET 404 for non-existent group', async () => {
    await spec()
      .get('/api/permissions/user-groups/nonexistent')
      .expectStatus(404);
  });

  it('POST validation error for missing name', async () => {
    await spec()
      .post('/api/permissions/user-groups')
      .withJson({})
      .expectStatus(400)
      .expectJson('error.code', 'VALIDATION_ERROR');
  });
});

// ═══════════════════════════════════════
// Permission groups CRUD
// ═══════════════════════════════════════

describe('Permission group CRUD', () => {
  it('POST creates a permission group with rules', async () => {
    await spec()
      .post('/api/permissions/groups')
      .withJson({
        name: 'Operators',
        rules: [
          { effect: 'allow', actions: ['read', 'update'], resource: 'sandbox', priority: 10 },
          { effect: 'deny', actions: ['delete'], priority: 99 },
        ],
        userGroupIds: ['$S{userGroupId}'],
      })
      .expectStatus(201)
      .expectJson('data.name', 'Operators')
      .expectJson('data.rules[0].effect', 'allow')
      .expectJson('data.rules[1].effect', 'deny')
      .stores('permGroupId', 'data.id');
  });

  it('GET lists all permission groups', async () => {
    await spec()
      .get('/api/permissions/groups')
      .expectStatus(200);
  });

  it('GET by id returns the group', async () => {
    await spec()
      .get('/api/permissions/groups/$S{permGroupId}')
      .expectStatus(200)
      .expectJson('data.name', 'Operators');
  });

  it('PUT adds userIds to the permission group', async () => {
    await spec()
      .put('/api/permissions/groups/$S{permGroupId}')
      .withJson({ userIds: ['$S{userId}'] })
      .expectStatus(200)
      .expectJson('data.userIds[0]', '$S{userId}');
  });

  it('DELETE removes the permission group', async () => {
    await spec()
      .delete('/api/permissions/groups/$S{permGroupId}')
      .expectStatus(200);

    await spec()
      .get('/api/permissions/groups/$S{permGroupId}')
      .expectStatus(404);
  });
});

// ═══════════════════════════════════════
// Templates
// ═══════════════════════════════════════

describe('Permission templates', () => {
  it('GET lists all templates', async () => {
    await spec()
      .get('/api/permissions/templates')
      .expectStatus(200);
  });

  it('GET by id returns a specific template', async () => {
    await spec()
      .get('/api/permissions/templates/admin')
      .expectStatus(200)
      .expectJson('data.id', 'admin')
      .expectJson('data.rules[0].effect', 'allow');
  });

  it('GET 404 for non-existent template', async () => {
    await spec()
      .get('/api/permissions/templates/fake')
      .expectStatus(404);
  });

  it('POST creates a permission group from admin template', async () => {
    await spec()
      .post('/api/permissions/groups/from-template/admin')
      .withJson({ name: 'My Admins' })
      .expectStatus(201)
      .expectJson('data.name', 'My Admins')
      .expectJson('data.rules[0].effect', 'allow')
      .stores('fromTplId', 'data.id');
  });

  it('POST creates from viewer template with userGroupIds', async () => {
    await spec()
      .post('/api/permissions/groups/from-template/viewer')
      .withJson({
        name: 'Viewer Group',
        userGroupIds: ['$S{userGroupId}'],
      })
      .expectStatus(201)
      .expectJson('data.rules[0].effect', 'allow');
  });

  it('POST 404 for non-existent template', async () => {
    await spec()
      .post('/api/permissions/groups/from-template/fake')
      .withJson({ name: 'Fake' })
      .expectStatus(404);
  });
});
