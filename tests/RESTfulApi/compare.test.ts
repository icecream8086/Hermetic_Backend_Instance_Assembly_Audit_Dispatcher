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

// ─── Helper: store pactum variable into a JS variable ───

let _grpA = '', _grpB = '', _grpX = '', _grpY = '';

// ═══════════════════════════════════════
// Compare — permission groups
// ═══════════════════════════════════════

describe('Compare permission groups', () => {
  beforeAll(async () => {
    await spec()
      .post('/api/permissions/groups')
      .withJson({ name: 'perm.A', rules: [{ effect: 'allow', actions: ['read'], priority: 10 }] })
      .expectStatus(201)
      .expect((ctx) => { _grpA = ctx.res.body?.data?.id; });

    await spec()
      .post('/api/permissions/groups')
      .withJson({ name: 'perm.B', rules: [{ effect: 'allow', actions: ['read'], priority: 10 }, { effect: 'allow', actions: ['write'], priority: 20 }] })
      .expectStatus(201)
      .expect((ctx) => { _grpB = ctx.res.body?.data?.id; });
  });

  it('compare returns common rule and onlyB rule', async () => {
    await spec()
      .post('/api/permissions/compare/perm-groups')
      .withJson({ idA: _grpA, idB: _grpB })
      .expectStatus(201)
      .expect((ctx) => {
        const d = ctx.res.body?.data;
        if (!d) throw new Error('No data');
        if (d.common.length !== 1) throw new Error(`Expected 1 common rule, got ${d.common.length}`);
        if (d.onlyA.length !== 0) throw new Error(`Expected 0 onlyA, got ${d.onlyA.length}`);
        if (d.onlyB.length !== 1) throw new Error(`Expected 1 onlyB (write), got ${d.onlyB.length}`);
      });
  });

  it('compare returns depDiff for permission groups', async () => {
    await spec()
      .post('/api/permissions/compare/perm-groups')
      .withJson({ idA: _grpA, idB: _grpB })
      .expectStatus(201)
      .expect((ctx) => {
        const d = ctx.res.body?.data;
        if (!d) throw new Error('No data');
        if (!Array.isArray(d.depDiff.common)) throw new Error('depDiff.common should be array');
        if (!Array.isArray(d.depDiff.onlyA)) throw new Error('depDiff.onlyA should be array');
        if (!Array.isArray(d.depDiff.onlyB)) throw new Error('depDiff.onlyB should be array');
      });
  });

  it('compare with non-existent group returns 404', async () => {
    await spec()
      .post('/api/permissions/compare/perm-groups')
      .withJson({ idA: _grpA, idB: 'nonexistent' })
      .expectStatus(404);
  });

  it('compare with missing ids returns 400', async () => {
    await spec()
      .post('/api/permissions/compare/perm-groups')
      .withJson({ idA: 'only' })
      .expectStatus(400);
  });
});

// ═══════════════════════════════════════
// Compare — user groups
// ═══════════════════════════════════════

describe('Compare user groups', () => {
  let usrA: string, usrB: string;

  beforeAll(async () => {
    await spec()
      .post('/api/users/register')
      .withJson({ email: 'usr-a@test.local', password: 'TestPass123', name: 'UserA', role: 'Viewer' })
      .expectStatus(201)
      .expect((ctx) => { usrA = ctx.res.body?.data?.user?.id; });

    await spec()
      .post('/api/users/register')
      .withJson({ email: 'usr-b@test.local', password: 'TestPass123', name: 'UserB', role: 'Viewer' })
      .expectStatus(201)
      .expect((ctx) => { usrB = ctx.res.body?.data?.user?.id; });

    await spec()
      .post('/api/permissions/user-groups')
      .withJson({ name: 'group.X', memberIds: [usrA] })
      .expectStatus(201)
      .expect((ctx) => { _grpX = ctx.res.body?.data?.id; });

    await spec()
      .post('/api/permissions/user-groups')
      .withJson({ name: 'group.Y', memberIds: [usrA, usrB] })
      .expectStatus(201)
      .expect((ctx) => { _grpY = ctx.res.body?.data?.id; });
  });

  it('compare returns member differences', async () => {
    await spec()
      .post('/api/permissions/compare/user-groups')
      .withJson({ idA: _grpX, idB: _grpY })
      .expectStatus(201)
      .expect((ctx) => {
        const d = ctx.res.body?.data;
        if (!d) throw new Error('No data');
        if (d.common.length !== 1) throw new Error(`Expected 1 common member, got ${d.common.length}`);
        if (d.onlyA.length !== 0) throw new Error(`Expected 0 onlyA, got ${d.onlyA.length}`);
        if (d.onlyB.length !== 1) throw new Error(`Expected 1 onlyB, got ${d.onlyB.length}`);
      });
  });

  it('compare returns depDiff for user groups', async () => {
    await spec()
      .post('/api/permissions/compare/user-groups')
      .withJson({ idA: _grpX, idB: _grpY })
      .expectStatus(201)
      .expect((ctx) => {
        const d = ctx.res.body?.data;
        if (!d) throw new Error('No data');
        if (!Array.isArray(d.depDiff.common)) throw new Error('depDiff.common should be array');
      });
  });

  it('compare non-existent returns 404', async () => {
    await spec()
      .post('/api/permissions/compare/user-groups')
      .withJson({ idA: 'nonexistent', idB: _grpY })
      .expectStatus(404);
  });

  it('same group compared to itself shows all common', async () => {
    await spec()
      .post('/api/permissions/compare/user-groups')
      .withJson({ idA: _grpX, idB: _grpX })
      .expectStatus(201)
      .expect((ctx) => {
        const d = ctx.res.body?.data;
        if (!d) throw new Error('No data');
        if (d.common.length === 0) throw new Error('Same group should have common members');
        if (d.onlyA.length !== 0 || d.onlyB.length !== 0) throw new Error('Same group should have no diffs');
      });
  });
});
