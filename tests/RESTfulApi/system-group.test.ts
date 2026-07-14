/// <reference types="pactum" />

import { describe, it, beforeAll, afterAll } from 'vitest';
import { spec, request } from 'pactum';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startTestServer } from './helper.ts';

let baseUrl: string;
let dispose: () => Promise<void>;
let token: string;

const ROOT_USER_ID = randomUUID();
const ROOT_EMAIL = 'root@sys.local';
const ROOT_SESSION = randomUUID();
const ROOT_GROUP_ID = `usergrp_${randomUUID()}`;
const NOW = Date.now();

function writeUserFile(dataDir: string, key: string, value: unknown) {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
  writeFileSync(join(dataDir, `${safe}.json`), JSON.stringify({ value, metadata: { v: randomUUID() } }));
}

beforeAll(async () => {
  const server = await startTestServer({
    authz: { enabled: true },
    beforeApp: (dataDir) => {
      writeUserFile(dataDir, `user:${ROOT_USER_ID}`, {
        id: ROOT_USER_ID, email: ROOT_EMAIL, name: 'Root', role: 'wheel',
        passwordHash: 'dummy:hash',
        loginPolicy: { enabled: true, timeRanges: [], allowedCIDRs: [] },
        createdAt: NOW, updatedAt: NOW,
      });
      writeUserFile(dataDir, `user:email:${ROOT_EMAIL}`, { id: ROOT_USER_ID });
      writeUserFile(dataDir, `session:${ROOT_SESSION}`, { token: ROOT_SESSION, userId: ROOT_USER_ID, createdAt: NOW });
      writeUserFile(dataDir, `user:lastSession:${ROOT_USER_ID}`, ROOT_SESSION);
      writeUserFile(dataDir, `usergroup:${ROOT_GROUP_ID}`, {
        id: ROOT_GROUP_ID, name: 'test_root', memberIds: [ROOT_USER_ID], createdAt: NOW, updatedAt: NOW,
      });
      writeUserFile(dataDir, 'usergroup:ids', [ROOT_GROUP_ID]);
      const aclId = `routeacl_${randomUUID()}`;
      writeUserFile(dataDir, `routeacl:${aclId}`, {
        id: aclId, method: '*', pathPrefix: '/api', matchType: 'prefix',
        effect: 'allow', userGroupId: ROOT_GROUP_ID, priority: 1000, createdAt: NOW, updatedAt: NOW,
      });
      writeUserFile(dataDir, 'routeacl:ids', [aclId]);
      let hash = 5381;
      for (let i = 0; i < ROOT_USER_ID.length; i++) { hash = ((hash << 5) + hash) + ROOT_USER_ID.charCodeAt(i); hash |= 0; }
      writeUserFile(dataDir, `user:idx:${Math.abs(hash) % 16}`, [ROOT_USER_ID]);
      writeUserFile(dataDir, '_sys:initialized', true);
    },
  });
  baseUrl = server.baseUrl;
  dispose = server.dispose;
  token = ROOT_SESSION;
  request.setBaseUrl(baseUrl);
});

afterAll(async () => {
  await dispose();
});

// ═══════════════════════════════════════
// System group CRUD
// ═══════════════════════════════════════

describe('System group CRUD', () => {
  it('GET lists seeded system groups and first group is fetchable by id', async () => {
    const res = await spec()
      .withHeaders('Authorization', 'Bearer ' + token)
      .get('/api/system-groups')
      .expectStatus(200);
    const items = res.body?.data?.items;
    if (!Array.isArray(items) || items.length === 0) throw new Error('Expected at least 1 seeded system group');
    const names = items.map((g: any) => g.name);
    if (!names.includes('perm.sysadmin')) throw new Error('Expected perm.sysadmin in seeded groups');
    const firstId = items[0].id;

    // Now fetch that first group by ID
    await spec()
      .withHeaders('Authorization', 'Bearer ' + token)
      .get('/api/system-groups/' + firstId)
      .expectStatus(200)
      .expectJson('data.id', firstId);
  });

  it('POST creates a new system group', async () => {
    await spec()
      .withHeaders('Authorization', 'Bearer ' + token)
      .post('/api/system-groups')
      .withJson({
        name: 'sys.custom',
        rules: [{ effect: 'allow' as const, actions: ['read'], priority: 10 }],
      })
      .expectStatus(201)
      .expect((ctx) => {
        const d = ctx.res.body?.data;
        if (!d) throw new Error('No data');
        if (d.name !== 'sys.custom') throw new Error(`Expected sys.custom, got ${d.name}`);
        if (!d.id) throw new Error('Expected id');
      });
  });

  it('POST creates with multiple rules', async () => {
    await spec()
      .withHeaders('Authorization', 'Bearer ' + token)
      .post('/api/system-groups')
      .withJson({
        name: 'sys.multirule',
        rules: [
          { effect: 'allow', actions: ['read', 'write'], priority: 20 },
          { effect: 'deny', actions: ['delete'], priority: 10 },
        ],
      })
      .expectStatus(201);
  });

  it('PUT updates group name and priority', async () => {
    await spec()
      .withHeaders('Authorization', 'Bearer ' + token)
      .post('/api/system-groups')
      .withJson({ name: 'sys.to-update', rules: [{ effect: 'allow', actions: ['read'], priority: 10 }] })
      .expectStatus(201)
      .expect((ctx) => {
        const id = ctx.res.body?.data?.id;
        return spec()
          .withHeaders('Authorization', 'Bearer ' + token)
          .put('/api/system-groups/' + id)
          .withJson({ name: 'sys.updated', rules: [{ effect: 'allow', actions: ['read'], priority: 50 }] })
          .expectStatus(200);
      });
  });

  it('PUT updates rules', async () => {
    await spec()
      .withHeaders('Authorization', 'Bearer ' + token)
      .post('/api/system-groups')
      .withJson({ name: 'sys.rules-update', rules: [{ effect: 'allow', actions: ['read'], priority: 10 }] })
      .expectStatus(201)
      .expect((ctx) => {
        const id = ctx.res.body?.data?.id;
        return spec()
          .withHeaders('Authorization', 'Bearer ' + token)
          .put('/api/system-groups/' + id)
          .withJson({ rules: [{ effect: 'allow', actions: ['admin'], priority: 100 }] })
          .expectStatus(200);
      });
  });

  it('GET lists all groups including custom ones', async () => {
    await spec()
      .withHeaders('Authorization', 'Bearer ' + token)
      .get('/api/system-groups')
      .expectStatus(200)
      .expect((ctx) => {
        const items = ctx.res.body?.data?.items;
        if (!items || items.length < 3) throw new Error(`Expected at least 3 groups, got ${items?.length}`);
        const names = items.map((g: any) => g.name);
        if (!names.includes('sys.custom')) throw new Error('Expected sys.custom');
      });
  });

  it('DELETE removes a group', async () => {
    await spec()
      .withHeaders('Authorization', 'Bearer ' + token)
      .post('/api/system-groups')
      .withJson({ name: 'sys.to-delete', rules: [{ effect: 'allow', actions: ['read'], priority: 10 }] })
      .expectStatus(201)
      .expect((ctx) => {
        const id = ctx.res.body?.data?.id;
        return spec()
          .withHeaders('Authorization', 'Bearer ' + token)
          .delete('/api/system-groups/' + id)
          .expectStatus(200);
      });
  });

  it('GET 404 for non-existent group', async () => {
    const fakeId = 'nonexistent';
    await spec()
      .withHeaders('Authorization', 'Bearer ' + token)
      .get('/api/system-groups/' + fakeId)
      .expectStatus(404);
  });

  it('POST validation error for missing name', async () => {
    await spec()
      .withHeaders('Authorization', 'Bearer ' + token)
      .post('/api/system-groups')
      .withJson({ rules: [] })
      .expectStatus(400);
  });

  it('PUT 404 on deleted group', async () => {
    await spec()
      .withHeaders('Authorization', 'Bearer ' + token)
      .put('/api/system-groups/nonexistent')
      .withJson({ name: 'ghost' })
      .expectStatus(404);
  });
});
