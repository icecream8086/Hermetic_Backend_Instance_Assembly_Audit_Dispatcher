/**
 * End-to-end authz tests.
 *
 * Starts a server WITH auth middleware enabled to test:
 *   401 — no/invalid token
 *   403 — valid token but no ACL / deny ACL
 *   200 — valid token + matching ACL
 *   ACL matchType, effect (allow/deny)
 *
 * Bootstrap: pre-writes a wheel user + ACLs directly to the file store
 * before the server starts, so the middleware has something to check.
 */

import { describe, it, beforeAll, afterAll } from 'vitest';
import { spec, request } from 'pactum';
import { serve, type ServerType } from '@hono/node-server';
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config/env.ts';
import { createApp } from '../../src/core/app.ts';

let server: ServerType;
let baseUrl: string;
let dataDir: string;
let dispose: () => Promise<void>;

// ─── Bootstrap: pre-write wheel user + group + ACLs ───

const WHEEL_USER_ID = randomUUID();
const WHEEL_EMAIL = 'wheel@e2e.local';
const WHEEL_PASSWORD_HASH = 'dummy:hash'; // login not tested, only token auth
const WHEEL_SESSION = randomUUID();
const WHEEL_GROUP_ID = `usergrp_${randomUUID()}`;
const NOW = Date.now();

function writeFileKV(key: string, value: unknown) {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
  const fp = join(dataDir, `${safe}.json`);
  writeFileSync(fp, JSON.stringify({ value, metadata: { v: randomUUID() } }));
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'hbi-auth-e2e-'));
  mkdirSync(dataDir, { recursive: true });

  // 1. Wheel user (Admin role)
  writeFileKV(`user:${WHEEL_USER_ID}`, {
    id: WHEEL_USER_ID, email: WHEEL_EMAIL, name: 'Wheel', role: 'root',
    passwordHash: WHEEL_PASSWORD_HASH,
    loginPolicy: { enabled: true, timeRanges: [], allowedCIDRs: [] },
    createdAt: NOW, updatedAt: NOW,
  });
  writeFileKV(`user:email:${WHEEL_EMAIL}`, { id: WHEEL_USER_ID });

  // 2. Session
  writeFileKV(`session:${WHEEL_SESSION}`, { token: WHEEL_SESSION, userId: WHEEL_USER_ID, createdAt: NOW });
  writeFileKV(`user:lastSession:${WHEEL_USER_ID}`, WHEEL_SESSION);

  // 3. Wheel user group
  writeFileKV(`usergroup:${WHEEL_GROUP_ID}`, {
    id: WHEEL_GROUP_ID, name: 'simulate_wheel', memberIds: [WHEEL_USER_ID], createdAt: NOW, updatedAt: NOW,
  });
  writeFileKV('usergroup:ids', [WHEEL_GROUP_ID]);

  // 4. Route ACLs — full access for wheel
  const wheelAclId = `routeacl_${randomUUID()}`;
  writeFileKV(`routeacl:${wheelAclId}`, {
    id: wheelAclId, method: '*', pathPrefix: '/api', matchType: 'prefix',
    effect: 'allow', userGroupId: WHEEL_GROUP_ID, priority: 1000, createdAt: NOW, updatedAt: NOW,
  });
  writeFileKV('routeacl:ids', [wheelAclId]);

  // 5. User ID shard index
  let hash = 5381;
  for (let i = 0; i < WHEEL_USER_ID.length; i++) { hash = ((hash << 5) + hash) + WHEEL_USER_ID.charCodeAt(i); hash |= 0; }
  writeFileKV(`user:idx:${Math.abs(hash) % 16}`, [WHEEL_USER_ID]);

  // 6. Start server with auth enabled
  const config = loadConfig({
    storage: { stateBackend: 'file', queryBackend: 'none', blobBackend: 'none', connections: { filePath: dataDir } },
    scheduler: { backend: 'worker', intervalMs: 60000, batchSize: 0 },
    authz: { enabled: true },
  });

  const instance = await createApp(config);

  await new Promise<void>((resolve, reject) => {
    server = serve({ fetch: instance.app.fetch, port: 0 }, (info) => {
      baseUrl = `http://localhost:${info.port}`;
      request.setBaseUrl(baseUrl);
      resolve();
    });
    server.on('error', reject);
  });

  dispose = async () => {
    await instance.dispose();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dataDir, { recursive: true, force: true });
  };
});

afterAll(async () => {
  await dispose();
});

// ═══════════════════════════════════════
// 401 — Unauthenticated
// ═══════════════════════════════════════

describe('Unauthenticated (401)', () => {
  it('no Authorization header', async () => {
    await spec()
      .get('/api/users/')
      .expectStatus(401)
      .expectJson('error.code', 'UNAUTHORIZED');
  });

  it('invalid token', async () => {
    await spec()
      .get('/api/users/')
      .withHeaders('Authorization', 'Bearer nonexistent')
      .expectStatus(401)
      .expectJson('error.code', 'UNAUTHORIZED');
  });

  it('empty token', async () => {
    await spec()
      .get('/api/users/')
      .withHeaders('Authorization', 'Bearer ')
      .expectStatus(401);
  });

  it('public paths (register) bypass auth', async () => {
    await spec()
      .post('/api/users/register')
      .withJson({ email: 'new@e2e.local', password: 'TestPass123', name: 'New', role: 'Viewer' })
      .expectStatus(201)
      .stores('newUserId', 'data.user.id')
      .stores('newToken', 'data.token');
  });
});

// ═══════════════════════════════════════
// 403 — Forbidden (no ACL or deny ACL)
// ═══════════════════════════════════════

describe('Forbidden (403)', () => {
  it('newUser has basic GET access via "users" group', async () => {
    // New users auto-join "users" group, which has GET /api/users ACL
    await spec()
      .get('/api/users/$S{newUserId}')
      .withHeaders('Authorization', 'Bearer $S{newToken}')
      .expectStatus(200);
  });

;

});

// ═══════════════════════════════════════
// 200 — ACL allow
// ═══════════════════════════════════════

describe('ACL allow (200)', () => {
  it('wheel user can GET /api/users (prefix-match ACL)', async () => {
    await spec()
      .get('/api/users/')
      .withHeaders('Authorization', 'Bearer ' + WHEEL_SESSION)
      .expectStatus(200);
  });

  it('wheel user can POST /api/permissions/policies', async () => {
    await spec()
      .post('/api/permissions/policies')
      .withHeaders('Authorization', 'Bearer ' + WHEEL_SESSION)
      .withJson({ name: 'Test policy', effect: 'allow', actions: ['read'] })
      .expectStatus(201);
  });

  it('wheel user can create ACLs for newUser', async () => {
    // Give newUser a GET-only ACL
    await spec()
      .post('/api/permissions/user-groups')
      .withHeaders('Authorization', 'Bearer ' + WHEEL_SESSION)
      .withJson({ name: 'readers', memberIds: ['$S{newUserId}'] })
      .expectStatus(201)
      .stores('readerGroupId', 'data.id');

    await spec()
      .post('/api/permissions/route-acls')
      .withHeaders('Authorization', 'Bearer ' + WHEEL_SESSION)
      .withJson({
        method: 'GET', pathPrefix: '/api/users', matchType: 'prefix',
        effect: 'allow', userGroupId: '$S{readerGroupId}', priority: 100,
      })
      .expectStatus(201);
  });

  it('newUser can now GET /api/users (ACL now exists)', async () => {
    await spec()
      .get('/api/users/')
      .withHeaders('Authorization', 'Bearer $S{newToken}')
      .expectStatus(200);
  });

  it('newUser cannot PUT (only GET ACL)', async () => {
    await spec()
      .put('/api/users/$S{newUserId}')
      .withHeaders('Authorization', 'Bearer $S{newToken}')
      .withJson({ name: 'Hacker' })
      .expectStatus(403);
  });
});

// ═══════════════════════════════════════
// ACL effect: deny overrides allow
// ═══════════════════════════════════════

describe('Deny overrides', () => {
  it('add deny DELETE ACL for wheel group, DELETE is blocked', async () => {
    // Create a deny ACL for DELETE on /api/users with higher priority
    await spec()
      .post('/api/permissions/route-acls')
      .withHeaders('Authorization', 'Bearer ' + WHEEL_SESSION)
      .withJson({
        method: 'DELETE', pathPrefix: '/api/users', matchType: 'prefix',
        effect: 'deny', userGroupId: WHEEL_GROUP_ID, priority: 2000,
      })
      .expectStatus(201);

    // Wheel can GET (allow ACL applies)
    await spec()
      .get('/api/users/')
      .withHeaders('Authorization', 'Bearer ' + WHEEL_SESSION)
      .expectStatus(200);

    // But DELETE is now denied (deny overrides)
    await spec()
      .delete('/api/users/' + WHEEL_USER_ID)
      .withHeaders('Authorization', 'Bearer ' + WHEEL_SESSION)
      .expectStatus(403);
  });
});

// ═══════════════════════════════════════
// ACL matchType: exact vs prefix
// ═══════════════════════════════════════

describe('matchType: exact vs prefix', () => {
  it('exact-match ACL for /api/users does not match /api/users/xxx', async () => {
    // Create an exact-match DENY for /api/users/public
    await spec()
      .post('/api/permissions/route-acls')
      .withHeaders('Authorization', 'Bearer ' + WHEEL_SESSION)
      .withJson({
        method: 'GET', pathPrefix: '/api/users/public', matchType: 'exact',
        effect: 'deny', userGroupId: WHEEL_GROUP_ID, priority: 3000,
      })
      .expectStatus(201);

    // GET /api/users/public → blocked (exact match)
    await spec()
      .get('/api/users/public')
      .withHeaders('Authorization', 'Bearer ' + WHEEL_SESSION)
      .expectStatus(403);

    // GET /api/users/$S{newUserId} → not blocked (doesn't exact-match /api/users/public)
    await spec()
      .get('/api/users/$S{newUserId}')
      .withHeaders('Authorization', 'Bearer ' + WHEEL_SESSION)
      .expectStatus(200);
  });
});

// ═══════════════════════════════════════
// Input validation — 400
// ═══════════════════════════════════════

describe('Input validation (400)', () => {
  it('POST policy without name', async () => {
    await spec()
      .post('/api/permissions/policies')
      .withHeaders('Authorization', 'Bearer ' + WHEEL_SESSION)
      .withJson({ effect: 'allow' })
      .expectStatus(400)
      .expectJson('error.code', 'VALIDATION_ERROR');
  });

  it('POST user-group without name', async () => {
    await spec()
      .post('/api/permissions/user-groups')
      .withHeaders('Authorization', 'Bearer ' + WHEEL_SESSION)
      .withJson({ memberIds: [] })
      .expectStatus(400)
      .expectJson('error.code', 'VALIDATION_ERROR');
  });

  it('POST permission-group without name', async () => {
    await spec()
      .post('/api/permissions/groups')
      .withHeaders('Authorization', 'Bearer ' + WHEEL_SESSION)
      .withJson({ rules: [] })
      .expectStatus(400)
      .expectJson('error.code', 'VALIDATION_ERROR');
  });

  it('POST route-acl without method', async () => {
    await spec()
      .post('/api/permissions/route-acls')
      .withHeaders('Authorization', 'Bearer ' + WHEEL_SESSION)
      .withJson({ pathPrefix: '/api' })
      .expectStatus(400)
      .expectJson('error.code', 'VALIDATION_ERROR');
  });

  it('POST check without userId', async () => {
    await spec()
      .post('/api/permissions/check')
      .withHeaders('Authorization', 'Bearer ' + WHEEL_SESSION)
      .withJson({ action: 'read', resource: 'user' })
      .expectStatus(400)
      .expectJson('error.code', 'VALIDATION_ERROR');
  });

  it('POST register with short password', async () => {
    await spec()
      .post('/api/users/register')
      .withJson({ email: 'bad@e2e.local', password: 'short', name: 'Bad', role: 'Viewer' })
      .expectStatus(400)
      .expectJson('error.code', 'VALIDATION_ERROR');
  });

  it('POST register with invalid email', async () => {
    await spec()
      .post('/api/users/register')
      .withJson({ email: 'not-email', password: 'TestPass123', name: 'Bad', role: 'Viewer' })
      .expectStatus(400)
      .expectJson('error.code', 'VALIDATION_ERROR');
  });
});
