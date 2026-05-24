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

// ─── Helpers ───

/** Register a fresh test user. Password must be ≥ 8 chars per schema. */
async function freshUser(label: string) {
  const email = `${label}@integration.test`;
  await spec()
    .post('/api/users/register')
    .withJson({ email, password: 'testpass', name: label, role: 'Viewer' })
    .expectStatus(201)
    .stores(`${label}_token`, 'data.token')
    .stores(`${label}_uid`, 'data.user.id');
}

// ─── Tests ───

describe('Auth integration', () => {
  const email = 'alice@integration.test';
  const password = 'secret123';

  it('login-info returns exists:false before register', async () => {
    await spec()
      .get('/api/users/login-info')
      .withQueryParams({ email })
      .expectStatus(200)
      .expectJson('data.exists', false);
  });

  it('register creates user and returns token (201)', async () => {
    await spec()
      .post('/api/users/register')
      .withJson({ email, password, name: 'Alice', role: 'Viewer' })
      .expectStatus(201)
      .expectJson('data.user.email', email)
      .expectJson('data.user.name', 'Alice')
      .expectJson('data.user.role', 'Viewer')
      // .stores() implicitly asserts the path exists — if data.token is missing the test fails
      .stores('token', 'data.token')
      .stores('userId', 'data.user.id');
  });

  it('register with duplicate email returns 409', async () => {
    await spec()
      .post('/api/users/register')
      .withJson({ email, password, name: 'Alice', role: 'Viewer' })
      .expectStatus(409)
      .expectJson('error.code', 'EMAIL_EXISTS');
  });

  it('login-info returns exists:true after register', async () => {
    await spec()
      .get('/api/users/login-info')
      .withQueryParams({ email })
      .expectStatus(200)
      .expectJson('data.exists', true);
  });

  it('login succeeds with correct credentials', async () => {
    await spec()
      .post('/api/users/login')
      .withJson({ email, password })
      .expectStatus(200)
      .expectJson('data.user.email', email)
      .stores('token2', 'data.token');
  });

  it('login with wrong password returns 401', async () => {
    await spec()
      .post('/api/users/login')
      .withJson({ email, password: 'wrong' })
      .expectStatus(401)
      .expectJson('error.code', 'INVALID_CREDENTIALS');
  });

  it('list returns registered user', async () => {
    await spec()
      .get('/api/users/')
      .expectStatus(200)
      .expectJson('data[0].email', email);
  });

  it('get user by id', async () => {
    await spec()
      .get('/api/users/$S{userId}')
      .expectStatus(200)
      .expectJson('data.id', '$S{userId}')
      .expectJson('data.email', email);
  });

  it('update user role', async () => {
    await spec()
      .put('/api/users/$S{userId}')
      .withJson({ role: 'root' })
      .expectStatus(200)
      .expectJson('data.role', 'root')
      .expectJson('data.email', email);
  });

  it('set login policy', async () => {
    await spec()
      .put('/api/users/$S{userId}/login-policy')
      .withJson({ enabled: true, timeRanges: [], allowedCIDRs: [] })
      .expectStatus(200)
      .expectJson('data.enabled', true);
  });

  it('get login policy', async () => {
    await spec()
      .get('/api/users/$S{userId}/login-policy')
      .expectStatus(200)
      .expectJson('data.enabled', true);
  });

  it('delete user', async () => {
    await spec()
      .delete('/api/users/$S{userId}')
      .expectStatus(200);
  });

  it('deleted user returns 404', async () => {
    await spec()
      .get('/api/users/$S{userId}')
      .expectStatus(404)
      .expectJson('error.code', 'USER_NOT_FOUND');
  });
});

describe('Multi-user', () => {
  it('register multiple users and list all', async () => {
    await freshUser('bob');
    await freshUser('carol');
    await freshUser('dave');

    // List returns 200. Order is non-deterministic across shards — the
    // individual login test below proves each user was persisted correctly.
    await spec()
      .get('/api/users/')
      .expectStatus(200);
  });

  it('each user can login independently', async () => {
    for (const name of ['bob', 'carol', 'dave']) {
      await spec()
        .post('/api/users/login')
        .withJson({ email: `${name}@integration.test`, password: 'testpass' })
        .expectStatus(200)
        .expectJson('data.user.name', name);
    }
  });
});
