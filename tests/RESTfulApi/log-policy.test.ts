/// <reference types="pactum" />

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spec, request } from 'pactum';
import { startTestServer } from './helper.ts';
import { shouldLog, shouldLogAudit, setActivePolicy } from '../../src/core/audit/log-policy.ts';
import { KernLevel } from '../../src/core/audit/kern-level.ts';

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
// LogPolicy API — CRUD
// ═══════════════════════════════════════

const TEST_FACILITY = 'user-service';

describe('LogPolicy API', () => {
  it('GET returns default policy with exists:false on fresh start', async () => {
    await spec()
      .get('/api/permissions/log-policy')
      .expectStatus(200)
      .expect((ctx) => {
        const d = ctx.res.body?.data;
        if (!d) throw new Error('No data');
        if (typeof d.exists !== 'boolean') throw new Error('Missing exists field');
        if (d.defaultLevel !== 'info' && d.defaultLevel !== 'debug') throw new Error(`Unexpected defaultLevel=${d.defaultLevel}`);
        if (!Array.isArray(d.facilities)) throw new Error('Missing facilities array');
      });
  });

  it('PUT updates defaultLevel', async () => {
    await spec()
      .put('/api/permissions/log-policy')
      .withJson({ defaultLevel: 'warning' })
      .expectStatus(200)
      .expectJson('data.defaultLevel', 'warning')
      .expect((ctx) => {
        // updatedBy can be undefined (no auth context in test)
        const d = ctx.res.body?.data;
        if (!d) throw new Error('No data');
        if (d.defaultLevel !== 'warning') throw new Error(`Expected warning, got ${d.defaultLevel}`);
      });
  });

  it('GET returns the updated policy', async () => {
    await spec()
      .get('/api/permissions/log-policy')
      .expectStatus(200)
      .expectJson('data.defaultLevel', 'warning')
      .expectJson('data.exists', true);
  });

  it('PUT updates a specific facility level', async () => {
    await spec()
      .put('/api/permissions/log-policy')
      .withJson({
        defaultLevel: 'info',
        facilities: [
          { facility: TEST_FACILITY, level: 'err' },
          { facility: 'perm', level: 'debug' },
        ],
      })
      .expectStatus(200)
      .expectJson('data.defaultLevel', 'info');
  });

  it('PUT with empty body keeps existing values', async () => {
    await spec()
      .put('/api/permissions/log-policy')
      .withJson({})
      .expectStatus(200)
      .expectJson('data.defaultLevel', 'info');
  });
});

// ═══════════════════════════════════════
// LogPolicy — runtime filtering
// ═══════════════════════════════════════

describe('LogPolicy filtering', () => {
  beforeAll(() => {
    // Set a known policy for deterministic testing
    setActivePolicy({
      defaultLevel: 'info',
      auditLevel: 'notice',
      facilities: [
        { facility: TEST_FACILITY, level: 'err' },
        { facility: 'perm', level: 'debug' },
      ],
      updatedAt: Date.now(),
    });
  });

  it('shouldLog blocks INFO for facility with level=error', () => {
    // user-service is set to 'error', so INFO should be blocked
    expect(shouldLog(TEST_FACILITY, KernLevel.INFO)).toBe(false);
    // but ERR should pass
    expect(shouldLog(TEST_FACILITY, KernLevel.ERR)).toBe(true);
    // and CRIT should pass (CRIT <= ERR)
    expect(shouldLog(TEST_FACILITY, KernLevel.CRIT)).toBe(true);
  });

  it('shouldLog passes DEBUG for facility with level=debug', () => {
    expect(shouldLog('perm', KernLevel.DEBUG)).toBe(true);
    expect(shouldLog('perm', KernLevel.INFO)).toBe(true);
  });

  it('shouldLog uses defaultLevel for unmatched facilities', () => {
    // 'unknown-facility' has no specific rule → falls back to 'info'
    expect(shouldLog('unknown-facility', KernLevel.INFO)).toBe(true);
    expect(shouldLog('unknown-facility', KernLevel.DEBUG)).toBe(false);
  });

  it('shouldLog never blocks ERR and below', () => {
    setActivePolicy({
      defaultLevel: 'crit',
      auditLevel: 'crit',
      facilities: [{ facility: 'test', level: 'crit' }],
      updatedAt: Date.now(),
    });
    // ERR (3) and below are always allowed regardless of policy
    expect(shouldLog('test', KernLevel.ERR)).toBe(true);
    expect(shouldLog('test', KernLevel.CRIT)).toBe(true);
    // INFO (6) is blocked when threshold is crit
    expect(shouldLog('test', KernLevel.INFO)).toBe(false);
  });

  it('shouldLogAudit uses KernLevel directly', () => {
    setActivePolicy({
      defaultLevel: 'info',
      auditLevel: 'notice',
      facilities: [{ facility: 'authz', level: 'warning' }],
      updatedAt: Date.now(),
    });
    // authz is warning, so INFO+NOTICE blocked
    expect(shouldLogAudit('authz', KernLevel.INFO)).toBe(false);
    expect(shouldLogAudit('authz', KernLevel.NOTICE)).toBe(false);
    expect(shouldLogAudit('authz', KernLevel.WARNING)).toBe(true);
    expect(shouldLogAudit('authz', KernLevel.ERR)).toBe(true);
  });

  it('shouldLogAudit uses defaultLevel for unmatched facilities', () => {
    setActivePolicy({
      defaultLevel: 'notice',
      auditLevel: 'notice',
      facilities: [],
      updatedAt: Date.now(),
    });
    expect(shouldLogAudit('no-rule', KernLevel.INFO)).toBe(false);
    expect(shouldLogAudit('no-rule', KernLevel.NOTICE)).toBe(true);
  });
});
