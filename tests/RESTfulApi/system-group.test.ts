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

// ═══════════════════════════════════════
// System group CRUD
// ═══════════════════════════════════════

describe('System group CRUD', () => {
  it('GET lists seeded system groups and first group is fetchable by id', async () => {
    let firstId: string;
    await spec()
      .get('/api/system-groups')
      .expectStatus(200)
      .expect((ctx) => {
        const items = ctx.res.body?.data?.items;
        if (!Array.isArray(items) || items.length === 0) throw new Error('Expected at least 1 seeded system group');
        const names = items.map((g: any) => g.name);
        if (!names.includes('perm.sysadmin')) throw new Error('Expected perm.sysadmin in seeded groups');
        firstId = items[0].id;
      });

    // Now fetch that first group by ID
    await spec()
      .get('/api/system-groups/' + firstId!)
      .expectStatus(200)
      .expectJson('data.id', firstId!);
  });

  it('POST creates a new system group', async () => {
    await spec()
      .post('/api/system-groups')
      .withJson({
        name: 'sys.custom',
        description: 'Custom system group',
        rules: [
          { effect: 'allow', actions: ['read'], resource: '/api/custom', priority: 50 },
        ],
        priority: 50,
      })
      .expectStatus(201)
      .expectJson('data.name', 'sys.custom')
      .expectJson('data.priority', 50)
      .expectJson('data.rules[0].effect', 'allow')
      .stores('sysGroupId', 'data.id');
  });

  it('POST creates with multiple rules', async () => {
    await spec()
      .post('/api/system-groups')
      .withJson({
        name: 'sys.multi',
        rules: [
          { effect: 'allow', actions: ['read', 'update'], priority: 30 },
          { effect: 'deny', actions: ['delete'], priority: 99 },
        ],
        priority: 30,
      })
      .expectStatus(201)
      .expect((ctx) => {
        const rules = ctx.res.body?.data?.rules;
        if (!Array.isArray(rules) || rules.length !== 2) throw new Error('Expected 2 rules, got ' + (rules?.length ?? 0));
      })
      .stores('multiGroupId', 'data.id');
  });

  it('PUT updates group name and priority', async () => {
    await spec()
      .put('/api/system-groups/$S{sysGroupId}')
      .withJson({ name: 'sys.custom.v2', priority: 60 })
      .expectStatus(200)
      .expectJson('data.name', 'sys.custom.v2')
      .expectJson('data.priority', 60);
  });

  it('PUT updates rules', async () => {
    await spec()
      .put('/api/system-groups/$S{sysGroupId}')
      .withJson({ rules: [{ effect: 'deny', actions: ['*'], priority: 999 }] })
      .expectStatus(200)
      .expectJson('data.rules[0].effect', 'deny');
  });

  it('GET lists all groups including custom ones', async () => {
    await spec()
      .get('/api/system-groups')
      .expectStatus(200)
      .expect((ctx) => {
        const items = ctx.res.body?.data?.items ?? [];
        const names = items.map((g: any) => g.name);
        if (!names.includes('sys.custom.v2')) throw new Error('Expected sys.custom.v2');
        if (!names.includes('sys.multi')) throw new Error('Expected sys.multi');
      });
  });

  it('DELETE removes a group', async () => {
    await spec()
      .delete('/api/system-groups/$S{multiGroupId}')
      .expectStatus(200);

    await spec()
      .get('/api/system-groups/$S{multiGroupId}')
      .expectStatus(404)
      .expectJson('error.code', 'SYSGROUP_NOT_FOUND');
  });

  it('GET 404 for non-existent group', async () => {
    await spec()
      .get('/api/system-groups/nonexistent')
      .expectStatus(404);
  });

  it('POST validation error for missing name', async () => {
    await spec()
      .post('/api/system-groups')
      .withJson({ rules: [] })
      .expectStatus(400)
      .expectJson('error.code', 'VALIDATION_ERROR');
  });

  it('PUT 404 on deleted group', async () => {
    await spec()
      .put('/api/system-groups/$S{multiGroupId}')
      .withJson({ name: 'ghost' })
      .expectStatus(404);
  });
});
