import { describe, it, expect, beforeEach } from 'vitest';
import { BasePermission } from '../../../src/core/permission/base.ts';
import { PermissionDag } from '../../../src/core/permission/permission-dag.ts';
import {
  PermissionEffect,
  PermissionAction,
  createPolicyId,
} from '../../../src/core/permission/types.ts';
import type {
  PolicyNode,
  PermissionCheck,
  PermissionResult,
  AuthzRecord,
  AuthzId,
} from '../../../src/core/permission/types.ts';
import type { IAtomicStore } from '../../../src/core/store/interfaces.ts';
import type { ILogWriter } from '../../../src/core/logger/interfaces.ts';
import type { LogInput } from '../../../src/core/logger/types.ts';
import type { LogId, VersionId } from '../../../src/core/brand.ts';

// ─── In-memory stubs ───

class StubAtomicStore implements IAtomicStore {
  readonly store = new Map<string, unknown>();
  private versionCounter = 0;

  async get<T>(key: string): Promise<{ value: T; version: VersionId } | null> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    return { value: raw as T, version: `v${this.versionCounter}` as VersionId };
  }

  async set<T>(key: string, value: T, _expectedVersion: VersionId | null, _ttlSeconds?: number): Promise<VersionId | null> {
    this.store.set(key, value);
    this.versionCounter++;
    return `v${this.versionCounter}` as VersionId;
  }

  async transact<T>(action: (txn: any) => Promise<T>): Promise<T> {
    return action({ get: async () => null, set: () => {} });
  }
}

class StubLogWriter implements ILogWriter {
  readonly entries: LogInput[] = [];

  async logSync(input: LogInput): Promise<LogId> {
    this.entries.push(input);
    return `log_${this.entries.length}` as LogId;
  }

  async logAsync(input: LogInput): Promise<void> {
    this.entries.push(input);
  }
}

// ─── Helper: policy factories ───

function allowPolicy(id: string, match: (p: PermissionCheck) => boolean, desc?: string): PolicyNode {
  return { id: createPolicyId(id), effect: PermissionEffect.ALLOW, description: desc, match };
}

function denyPolicy(id: string, match: (p: PermissionCheck) => boolean, desc?: string): PolicyNode {
  return { id: createPolicyId(id), effect: PermissionEffect.DENY, description: desc, match };
}

// ─── Test helpers (white-box) ───

class TestPermission extends BasePermission {
  constructor(deps: { atomic: IAtomicStore; logger: ILogWriter }, maxRecent?: number) {
    super(deps, maxRecent);
  }

  // Expose protected record() for tests
  exposeRecord(params: PermissionCheck, result: PermissionResult): Promise<AuthzId> {
    return this.record(params, result);
  }

  // Expose cache/query methods
  exposeGetCached(params: PermissionCheck): boolean | undefined {
    return this.getCached(params);
  }

  exposeClearCache(): void {
    this.clearCache();
  }

  exposeQueryRecent(predicate: (r: AuthzRecord) => boolean): AuthzRecord[] {
    return this.queryRecent(predicate);
  }

  exposeAllow(params: PermissionCheck, reason: string): Promise<PermissionResult> {
    return this.allow(params, reason);
  }

  exposeDeny(params: PermissionCheck, reason: string): Promise<PermissionResult> {
    return this.deny(params, reason);
  }

  // Access stores for verification
  get atomic(): StubAtomicStore { return this.deps.atomic as StubAtomicStore; }
  get logWriter(): StubLogWriter { return this.deps.logger as StubLogWriter; }
}

// ─── Tests ───

describe('PermissionDag (white-box)', () => {
  const aliceRead: PermissionCheck = {
    actor: 'user:alice',
    action: PermissionAction.READ,
    resource: 'sandbox',
    resourceId: 'sb-123',
  };

  describe('evaluate — no matching policy', () => {
    it('denies when DAG is empty', () => {
      const dag = new PermissionDag();
      const result = dag.evaluate(aliceRead);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('No matching policy');
    });
  });

  describe('evaluate — deny-overrides strategy', () => {
    it('allows when a matching ALLOW policy exists', () => {
      const dag = new PermissionDag();
      dag.addPolicy(allowPolicy('allow-all', () => true, 'Allow everything'));
      expect(dag.evaluate(aliceRead).allowed).toBe(true);
    });

    it('denies when only a matching DENY policy exists', () => {
      const dag = new PermissionDag();
      dag.addPolicy(denyPolicy('deny-all', () => true, 'Deny everything'));
      expect(dag.evaluate(aliceRead).allowed).toBe(false);
    });

    it('deny overrides allow when both match', () => {
      const dag = new PermissionDag();
      dag.addPolicy(allowPolicy('allow-all', () => true));
      dag.addPolicy(denyPolicy('deny-all', () => true));
      expect(dag.evaluate(aliceRead).allowed).toBe(false);
    });

    it('denies when no policy matches', () => {
      const dag = new PermissionDag();
      dag.addPolicy(allowPolicy('never-match', () => false));
      dag.addPolicy(denyPolicy('never-match-either', () => false));
      expect(dag.evaluate(aliceRead).allowed).toBe(false);
    });

    it('returns the matching policy in result', () => {
      const dag = new PermissionDag();
      dag.addPolicy(allowPolicy('admin-rule', p => p.actor === 'user:alice', 'Alice rule'));
      const result = dag.evaluate(aliceRead);
      expect(result.allowed).toBe(true);
      expect(result.matchedPolicy).toBeDefined();
      expect(result.matchedPolicy!.description).toBe('Alice rule');
    });
  });

  describe('evaluate — dependency ordering', () => {
    it('respects topological order via addDependency', () => {
      const dag = new PermissionDag();
      dag.addPolicy(allowPolicy('specific-allow', p => p.resourceId === 'sb-123'));
      dag.addPolicy(denyPolicy('deny-all', () => true));
      // Without dependency, sort order is undefined. But deny-all should still win.
      // Both match → deny overrides → denied.
      expect(dag.evaluate(aliceRead).allowed).toBe(false);
    });

    it('matching ALLOW continues evaluating if later node may deny', () => {
      const dag = new PermissionDag();
      let allowEvaluated = false;
      let denyEvaluated = false;
      dag.addPolicy(allowPolicy('allow-first', () => { allowEvaluated = true; return true; }));
      dag.addPolicy(denyPolicy('deny-second', () => { denyEvaluated = true; return true; }));
      dag.addDependency(createPolicyId('allow-first'), createPolicyId('deny-second'));

      expect(dag.evaluate(aliceRead).allowed).toBe(false);
      expect(allowEvaluated).toBe(true);
      expect(denyEvaluated).toBe(true);
    });
  });

  describe('evaluate — cycle detection', () => {
    it('returns denied with cycle message on cyclic graph', () => {
      const dag = new PermissionDag();
      const a = createPolicyId('a');
      const b = createPolicyId('b');
      dag.addPolicy(allowPolicy('a', () => true));
      dag.addPolicy(allowPolicy('b', () => true));
      dag.addDependency(a, b);
      dag.addDependency(b, a);  // cycle!
      const result = dag.evaluate(aliceRead);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('cycle');
    });
  });
});

describe('BasePermission (white-box)', () => {
  let atomic: StubAtomicStore;
  let logger: StubLogWriter;
  let perm: TestPermission;

  const basicCheck: PermissionCheck = {
    actor: 'user:alice',
    action: PermissionAction.READ,
    resource: 'sandbox',
    resourceId: 'sb-123',
  };

  beforeEach(() => {
    atomic = new StubAtomicStore();
    logger = new StubLogWriter();
    perm = new TestPermission({ atomic, logger });
  });

  // ─── check() via DAG ───

  describe('check with DAG', () => {
    it('allows when a matching ALLOW policy exists', async () => {
      perm.addPolicy(allowPolicy('allow-all', () => true));
      const result = await perm.check(basicCheck);
      expect(result.allowed).toBe(true);
    });

    it('denies when no policy matches', async () => {
      perm.addPolicy(allowPolicy('never-match', () => false));
      const result = await perm.check(basicCheck);
      expect(result.allowed).toBe(false);
    });

    it('deny overrides allow', async () => {
      perm.addPolicy(allowPolicy('allow-all', () => true));
      perm.addPolicy(denyPolicy('deny-all', () => true));
      const result = await perm.check(basicCheck);
      expect(result.allowed).toBe(false);
    });

    it('records audit log on check', async () => {
      perm.addPolicy(allowPolicy('allow-all', () => true));
      await perm.check(basicCheck);
      expect(logger.entries.length).toBeGreaterThan(0);
      expect(logger.entries[0]!.facility).toBe('authz');
    });
  });

  // ─── record() ───

  describe('record', () => {
    it('persists decision to atomic store with authz: prefix', async () => {
      const id = await perm.exposeRecord(basicCheck, { allowed: true, reason: 'Policy match' });
      expect(id).toMatch(/^authz_/);

      const stored = await atomic.get<AuthzRecord>(`authz:${id}`);
      expect(stored).not.toBeNull();
      expect(stored!.value.actor).toBe('user:alice');
      expect(stored!.value.action).toBe(PermissionAction.READ);
      expect(stored!.value.allowed).toBe(true);
    });

    it('writes audit log entry with correct level', async () => {
      await perm.exposeRecord(basicCheck, { allowed: false, reason: 'Denied' });
      expect(logger.entries[0]!.message).toContain('Denied');
    });

    it('includes context metadata', async () => {
      const checkWithCtx: PermissionCheck = {
        ...basicCheck,
        context: { ip: '10.0.0.1' },
      };
      const id = await perm.exposeRecord(checkWithCtx, { allowed: true, reason: 'OK' });
      const stored = await atomic.get<AuthzRecord>(`authz:${id}`);
      expect(stored!.value.metadata).toEqual({ ip: '10.0.0.1' });
    });
  });

  // ─── allow() / deny() convenience ───

  describe('allow / deny helpers', () => {
    it('allow records and returns true', async () => {
      const result = await perm.exposeAllow(basicCheck, 'Admin');
      expect(result.allowed).toBe(true);
      expect(logger.entries[0]!.message).toContain('Authorized');
    });

    it('deny records and returns false', async () => {
      const result = await perm.exposeDeny(basicCheck, 'Blocked');
      expect(result.allowed).toBe(false);
      expect(logger.entries[0]!.message).toContain('Denied');
    });
  });

  // ─── Decision cache ───

  describe('getCached', () => {
    it('returns undefined for uncached params', () => {
      expect(perm.exposeGetCached(basicCheck)).toBeUndefined();
    });

    it('returns cached value after check()', async () => {
      perm.addPolicy(allowPolicy('allow-all', () => true));
      await perm.check(basicCheck);
      expect(perm.exposeGetCached(basicCheck)).toBe(true);
    });

    it('distinguishes different actors', async () => {
      perm.addPolicy(allowPolicy('allow-alice', p => p.actor === 'user:alice'));
      await perm.check(basicCheck);
      expect(perm.exposeGetCached(basicCheck)).toBe(true);
      expect(perm.exposeGetCached({ ...basicCheck, actor: 'user:bob' })).toBeUndefined();
    });

    it('cache hit returns immediately without recording', async () => {
      perm.addPolicy(allowPolicy('allow-all', () => true));
      await perm.check(basicCheck);
      const beforeCount = logger.entries.length;

      const result = await perm.check(basicCheck);
      expect(result.allowed).toBe(true);
      expect(logger.entries.length).toBe(beforeCount);  // no new log entry
    });
  });

  // ─── Recent records buffer ───

  describe('queryRecent', () => {
    it('returns empty when no records', () => {
      expect(perm.exposeQueryRecent(() => true)).toEqual([]);
    });

    it('returns matching records', async () => {
      perm.addPolicy(allowPolicy('allow-all', () => true));
      await perm.check(basicCheck);
      await perm.check({ ...basicCheck, resourceId: 'sb-999' });

      const sb123 = perm.exposeQueryRecent(r => r.resourceId === 'sb-123');
      expect(sb123).toHaveLength(1);
    });

    it('bounded by maxRecent limit', async () => {
      const tight = new TestPermission({ atomic, logger }, 5);
      tight.addPolicy(allowPolicy('allow-all', () => true));
      for (let i = 0; i < 10; i++) {
        await tight.check({ ...basicCheck, resourceId: `sb-${i}` });
      }
      expect(tight.exposeQueryRecent(() => true)).toHaveLength(5);
    });
  });

  // ─── Cache management ───

  describe('clearCache', () => {
    it('empties the decision cache and record buffer', async () => {
      perm.addPolicy(allowPolicy('allow-all', () => true));
      await perm.check(basicCheck);
      expect(perm.exposeGetCached(basicCheck)).toBe(true);

      perm.exposeClearCache();

      expect(perm.exposeGetCached(basicCheck)).toBeUndefined();
      expect(perm.exposeQueryRecent(() => true)).toEqual([]);
    });
  });

  // ─── Subclass extension ───

  describe('subclass extension', () => {
    it('subclass adds policies in constructor', async () => {
      class SandboxPermission extends BasePermission {
        constructor(deps: { atomic: IAtomicStore; logger: ILogWriter }) {
          super(deps);
          this.addPolicy(allowPolicy('allow-sb-123', p => p.resourceId === 'sb-123', 'Sandbox 123 allowed'));
        }
      }

      const sp = new SandboxPermission({ atomic, logger });

      const resultAllow = await sp.check(basicCheck);
      expect(resultAllow.allowed).toBe(true);

      // Different resourceId — no policy matches → deny
      const resultDeny = await sp.check({ ...basicCheck, resourceId: 'sb-999' });
      expect(resultDeny.allowed).toBe(false);
    });

    it('subclass overrides check() with short-circuit', async () => {
      class AdminBypass extends BasePermission {
        constructor(deps: { atomic: IAtomicStore; logger: ILogWriter }) {
          super(deps);
          this.addPolicy(denyPolicy('deny-all', () => true));
        }

        async check(params: PermissionCheck): Promise<PermissionResult> {
          if (params.actor === 'admin:root') {
            return this.allow(params, 'Root bypass');
          }
          return super.check(params);
        }
      }

      const bp = new AdminBypass({ atomic, logger });

      const adminResult = await bp.check({ ...basicCheck, actor: 'admin:root' });
      expect(adminResult.allowed).toBe(true);

      const userResult = await bp.check(basicCheck);
      expect(userResult.allowed).toBe(false);
    });

    it('subclass adds dependency edges', async () => {
      class OrderedPermission extends BasePermission {
        constructor(deps: { atomic: IAtomicStore; logger: ILogWriter }) {
          super(deps);
          const specific = createPolicyId('specific-allow');
          const general = createPolicyId('general-deny');
          this.addPolicy(allowPolicy('specific-allow', p => p.resourceId === 'sb-123'));
          this.addPolicy(denyPolicy('general-deny', () => true));
          this.addDependency(specific, general);
        }
      }

      const op = new OrderedPermission({ atomic, logger });

      // Even though specific-allow matches, general-deny runs after and denies
      const result = await op.check(basicCheck);
      expect(result.allowed).toBe(false);

      // Different resource — no allow matches, general-deny still denies
      const result2 = await op.check({ ...basicCheck, resourceId: 'sb-other' });
      expect(result2.allowed).toBe(false);
    });
  });

  // ─── KV log persistence ───

  describe('KV log persistence', () => {
    it('stores authz records retrievable by key', async () => {
      const id = await perm.exposeRecord(basicCheck, { allowed: true, reason: 'Persisted' });
      const stored = await atomic.get<AuthzRecord>(`authz:${id}`);
      expect(stored).not.toBeNull();
      expect(stored!.value.id).toBe(id);
    });

    it('persists multiple records independently', async () => {
      const id1 = await perm.exposeRecord({ ...basicCheck, resourceId: 'sb-1' }, { allowed: true, reason: 'First' });
      const id2 = await perm.exposeRecord({ ...basicCheck, resourceId: 'sb-2' }, { allowed: false, reason: 'Second' });

      const s1 = await atomic.get<AuthzRecord>(`authz:${id1}`);
      const s2 = await atomic.get<AuthzRecord>(`authz:${id2}`);
      expect(s1!.value.resourceId).toBe('sb-1');
      expect(s2!.value.resourceId).toBe('sb-2');
    });
  });
});
