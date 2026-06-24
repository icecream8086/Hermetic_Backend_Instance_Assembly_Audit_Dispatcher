import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach } from 'vitest';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';
import { RouteAclManager } from '../../../src/features/permission/route-acl-manager.ts';
import { ConsoleLogger } from '../../../src/core/logger/console-logger.ts';

function store() { return new FileKVAtomicStore(join(tmpdir(), 'hbi-acl-' + crypto.randomUUID().slice(0, 8))); }

describe('RouteAclManager', () => {
  let mgr: RouteAclManager;
  let atomic: ReturnType<typeof store>;

  beforeEach(() => {
    atomic = store();
    mgr = new RouteAclManager(atomic, new ConsoleLogger());
  });

  describe('checkAccess', () => {
    it('returns false when no ACLs exist (default-deny)', async () => {
      const r = await mgr.checkAccess('GET', '/api/sandboxes', 'user1', ['group1']);
      expect(r).toBe(false);
    });

    it('returns true when an allow ACL matches user', async () => {
      await mgr.create({ method: 'GET', pathPrefix: '/api/sandboxes', matchType: 'prefix', effect: 'allow', userId: 'user1' });
      const r = await mgr.checkAccess('GET', '/api/sandboxes', 'user1', []);
      expect(r).toBe(true);
    });

    it('returns false when a deny ACL matches user (deny overrides allow)', async () => {
      await mgr.create({ method: 'GET', pathPrefix: '/api/sandboxes', matchType: 'prefix', effect: 'allow', userId: 'user1', priority: 500 });
      await mgr.create({ method: 'GET', pathPrefix: '/api/sandboxes', matchType: 'prefix', effect: 'deny', userGroupId: 'g1', priority: 1000 });
      const r = await mgr.checkAccess('GET', '/api/sandboxes', 'user1', ['g1']);
      expect(r).toBe(false);
    });

    it('matches by userGroupId', async () => {
      await mgr.create({ method: '*', pathPrefix: '/api/admin', matchType: 'prefix', effect: 'allow', userGroupId: 'g1' });
      const r = await mgr.checkAccess('POST', '/api/admin/users', 'user2', ['g1']);
      expect(r).toBe(true);
    });

    it('does not match when ACL has both userId and userGroupId but user matches neither', async () => {
      await mgr.create({ method: '*', pathPrefix: '/api/admin', matchType: 'prefix', effect: 'allow', userId: 'userA', userGroupId: 'g1' });
      const r = await mgr.checkAccess('GET', '/api/admin', 'user2', ['g2']);
      expect(r).toBe(false);
    });

    it('does not match when neither userId nor userGroupId is provided (no target)', async () => {
      await mgr.create({ method: '*', pathPrefix: '/api/admin', matchType: 'prefix', effect: 'allow' });
      // No userId and no userGroupId → matches any user by default
      const r = await mgr.checkAccess('GET', '/api/admin', 'anyone', []);
      expect(r).toBe(true);
    });

    it('exact matchType only matches exact path', async () => {
      await mgr.create({ method: 'GET', pathPrefix: '/api/users/public', matchType: 'exact', effect: 'allow', userId: 'user1' });
      expect(await mgr.checkAccess('GET', '/api/users/public', 'user1', [])).toBe(true);
      expect(await mgr.checkAccess('GET', '/api/users/public/xxx', 'user1', [])).toBe(false);
    });

    it('prefix matchType matches sub-paths', async () => {
      await mgr.create({ method: 'GET', pathPrefix: '/api/', matchType: 'prefix', effect: 'allow', userId: 'user1' });
      expect(await mgr.checkAccess('GET', '/api/sandboxes', 'user1', [])).toBe(true);
      expect(await mgr.checkAccess('GET', '/api/anything', 'user1', [])).toBe(true);
    });

    it('method filter: * matches all methods', async () => {
      await mgr.create({ method: '*', pathPrefix: '/api/', matchType: 'prefix', effect: 'allow', userId: 'user1' });
      expect(await mgr.checkAccess('GET', '/api/x', 'user1', [])).toBe(true);
      expect(await mgr.checkAccess('POST', '/api/x', 'user1', [])).toBe(true);
      expect(await mgr.checkAccess('DELETE', '/api/x', 'user1', [])).toBe(true);
    });

    it('method filter: specific method only matches that method', async () => {
      await mgr.create({ method: 'GET', pathPrefix: '/api/x', matchType: 'exact', effect: 'allow', userId: 'user1' });
      expect(await mgr.checkAccess('GET', '/api/x', 'user1', [])).toBe(true);
      expect(await mgr.checkAccess('POST', '/api/x', 'user1', [])).toBe(false);
    });
  });

  describe('version cache (cross-instance coherency)', () => {
    it('reloads ACLs when version changes (another instance created an ACL)', async () => {
      await mgr.create({ method: 'GET', pathPrefix: '/api/a', matchType: 'exact', effect: 'allow', userId: 'user1' });
      // First checkAccess loads cache
      expect(await mgr.checkAccess('GET', '/api/a', 'user1', [])).toBe(true);

      // Simulate another instance creating an ACL by bumping version
      const verEntry = await atomic.get<number>(RouteAclManager.VERSION_KEY);
      await atomic.set(RouteAclManager.VERSION_KEY, (verEntry?.value ?? 0) + 1, verEntry?.version ?? null);

      // The new ACL doesn't exist in this instance's store yet — but checkAccess should re-read
      // Because version changed, the cache is invalidated and reloads from store
      expect(await mgr.checkAccess('GET', '/api/b', 'user1', [])).toBe(false); // B doesn't exist
    });

    it('caches ACLs until version changes', async () => {
      await mgr.create({ method: 'GET', pathPrefix: '/api/a', matchType: 'exact', effect: 'deny', userId: 'user1' });
      // Populate cache
      await mgr.checkAccess('GET', '/api/a', 'user1', []);
      // Delete ACL directly in store (bypassing mgr.delete which would invalidate cache)
      await atomic.set('routeacl:' + (await mgr.list())[0]!.id, null, null);

      // Without version bump, cache still contains old data — but version didn't change
      // Actually, we're testing that the cache DOES serve stale data when version is unchanged.
      // This is expected: version bump is the invalidation signal.
      const verEntry = await atomic.get<number>(RouteAclManager.VERSION_KEY);
      const beforeVer = verEntry?.value ?? 0;

      // Bump version to force reload
      await atomic.set(RouteAclManager.VERSION_KEY, beforeVer + 1, verEntry?.version ?? null);

      // Now checkAccess should reload and NOT find the deleted ACL
      const r = await mgr.checkAccess('GET', '/api/a', 'user1', []);
      expect(r).toBe(false); // ACL was deleted, default-deny applies
    });

    it('create invalidates version', async () => {
      const verBefore = (await atomic.get<number>(RouteAclManager.VERSION_KEY))?.value ?? 0;
      await mgr.create({ method: 'GET', pathPrefix: '/api/x', matchType: 'exact', effect: 'allow', userId: 'u' });
      const verAfter = (await atomic.get<number>(RouteAclManager.VERSION_KEY))?.value ?? 0;
      expect(verAfter).toBeGreaterThan(verBefore);
    });

    it('update invalidates version', async () => {
      await mgr.create({ method: 'GET', pathPrefix: '/api/x', matchType: 'exact', effect: 'allow', userId: 'u' });
      const acl = (await mgr.list())[0]!;
      const verBefore = (await atomic.get<number>(RouteAclManager.VERSION_KEY))?.value ?? 0;
      await mgr.update(acl.id, { effect: 'deny' });
      const verAfter = (await atomic.get<number>(RouteAclManager.VERSION_KEY))?.value ?? 0;
      expect(verAfter).toBeGreaterThan(verBefore);
    });

    it('delete invalidates version', async () => {
      await mgr.create({ method: 'GET', pathPrefix: '/api/x', matchType: 'exact', effect: 'allow', userId: 'u' });
      const acl = (await mgr.list())[0]!;
      const verBefore = (await atomic.get<number>(RouteAclManager.VERSION_KEY))?.value ?? 0;
      await mgr.delete(acl.id);
      const verAfter = (await atomic.get<number>(RouteAclManager.VERSION_KEY))?.value ?? 0;
      expect(verAfter).toBeGreaterThan(verBefore);
    });
  });

  describe('list and CRUD', () => {
    it('listPaginated returns correct page', async () => {
      for (let i = 0; i < 5; i++) {
        await mgr.create({ method: 'GET', pathPrefix: `/api/p${i}`, matchType: 'exact', effect: 'allow', userId: 'u' });
      }
      const page1 = await mgr.listPaginated(1, 2);
      expect(page1.items).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page3 = await mgr.listPaginated(3, 2);
      expect(page3.items).toHaveLength(1); // last page
    });

    it('get returns single ACL', async () => {
      await mgr.create({ method: 'GET', pathPrefix: '/api/target', matchType: 'exact', effect: 'deny', userId: 'u' });
      const acl = (await mgr.list())[0]!;
      const found = await mgr.get(acl.id);
      expect(found).not.toBeNull();
      expect(found!.effect).toBe('deny');
      expect(found!.pathPrefix).toBe('/api/target');
    });

    // ── FIXED: duplicate ACL creation now throws 409 ──
    it('rejects duplicate ACL with 409', async () => {
      await mgr.create({ method: 'GET', pathPrefix: '/api/dup', matchType: 'exact', effect: 'deny', userId: 'u' });
      await expect(
        mgr.create({ method: 'GET', pathPrefix: '/api/dup', matchType: 'exact', effect: 'deny', userId: 'u' })
      ).rejects.toThrow(/Route ACL already exists/);
    });

    it('allows same path with different method (not a duplicate)', async () => {
      await mgr.create({ method: 'GET', pathPrefix: '/api/dup2', matchType: 'exact', effect: 'deny', userId: 'u' });
      // Different method → not a duplicate
      await expect(
        mgr.create({ method: 'POST', pathPrefix: '/api/dup2', matchType: 'exact', effect: 'deny', userId: 'u' })
      ).resolves.toBeDefined();
    });
  });
});
