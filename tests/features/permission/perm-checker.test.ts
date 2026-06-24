import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';
import { PermissionChecker } from '../../../src/features/permission/perm-checker.ts';
import { ConsoleLogger } from '../../../src/core/logger/console-logger.ts';
import type { PermissionRule } from '../../../src/features/permission/types.ts';

function store() { return new FileKVAtomicStore(join(tmpdir(), 'hbi-perm-' + crypto.randomUUID().slice(0, 8))); }

const emptyMacRules: PermissionRule[] = [];

describe('PermissionChecker', () => {
  let checker: PermissionChecker;
  let atomic: ReturnType<typeof store>;

  beforeEach(() => {
    atomic = store();
    checker = new PermissionChecker(atomic, new ConsoleLogger());
  });

  describe('check', () => {
    it('returns denied when user does not exist', async () => {
      const r = await checker.check({ userId: 'missing', action: 'read', resource: 'sandbox' }, emptyMacRules);
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('User not found');
    });

    it('returns denied when user exists but no policies or groups grant access', async () => {
      await atomic.set('user:u1', { id: 'u1', name: 'Test' }, null);
      const r = await checker.check({ userId: 'u1', action: 'read', resource: 'sandbox' }, emptyMacRules);
      expect(r.allowed).toBe(false);
    });

    it('grants access via global allow policy matching user', async () => {
      await atomic.set('user:u1', { id: 'u1', name: 'Test' }, null);
      // Seed an enabled allow-all policy
      const policy = { id: 'pol_1', name: 'Allow All', effect: 'allow' as const, actions: ['*'], resource: '*', priority: 1000, enabled: true, createdAt: Date.now(), updatedAt: Date.now() };
      await atomic.set('policy:ids', ['pol_1'], null);
      await atomic.set('policy:pol_1', policy, null);
      checker.invalidateCache();

      const r = await checker.check({ userId: 'u1', action: 'read', resource: 'sandbox' }, emptyMacRules);
      expect(r.allowed).toBe(true);
    });

    it('denies when MAC rule denies and global policy allows (deny-overrides)', async () => {
      await atomic.set('user:u1', { id: 'u1', name: 'Test' }, null);
      const macRules: PermissionRule[] = [{ effect: 'deny', actions: ['*'], resource: '*', priority: 5000 }];
      const r = await checker.check({ userId: 'u1', action: 'read', resource: 'sandbox' }, macRules);
      expect(r.allowed).toBe(false);
    });

    it('grants access via user group rule', async () => {
      await atomic.set('user:u1', { id: 'u1', name: 'Test' }, null);
      // Create user group with member u1
      const ug = { id: 'ug1', name: 'Devs', memberIds: ['u1'], rules: [] as PermissionRule[], createdAt: Date.now(), updatedAt: Date.now() };
      await atomic.set('usergroup:ids', ['ug1'], null);
      await atomic.set('usergroup:ug1', ug, null);
      // Create perm group linked to ug1 with an allow rule
      const pg = { id: 'pg1', name: 'Dev Access', userGroupIds: ['ug1'], rules: [{ effect: 'allow' as const, actions: ['read'], resource: 'sandbox' }], createdAt: Date.now(), updatedAt: Date.now() };
      await atomic.set('permgroup:ids', ['pg1'], null);
      await atomic.set('permgroup:pg1', pg, null);
      checker.invalidateCache();

      const r = await checker.check({ userId: 'u1', action: 'read', resource: 'sandbox' }, emptyMacRules);
      expect(r.allowed).toBe(true);
    });

    it('denies when action does not match any rule', async () => {
      await atomic.set('user:u1', { id: 'u1', name: 'Test' }, null);
      await atomic.set('policy:ids', [], null);
      checker.invalidateCache();
      const r = await checker.check({ userId: 'u1', action: 'delete', resource: 'sandbox' }, emptyMacRules);
      expect(r.allowed).toBe(false);
    });

    it('handles $self resource expansion', async () => {
      await atomic.set('user:u1', { id: 'u1', name: 'Test' }, null);
      const policy = { id: 'pol_self', name: 'Own Resources', effect: 'allow' as const, actions: ['*'], resource: 'sandbox:$self', priority: 1000, enabled: true, createdAt: Date.now(), updatedAt: Date.now() };
      await atomic.set('policy:ids', ['pol_self'], null);
      await atomic.set('policy:pol_self', policy, null);
      checker.invalidateCache();

      // Matches because $self expands to resourceOwnerId
      const r = await checker.check({
        userId: 'u1', action: 'read', resource: 'sandbox:u1', resourceOwnerId: 'u1',
      }, emptyMacRules);
      expect(r.allowed).toBe(true);
    });
  });

  describe('cache', () => {
    it('serves from cache within TTL (5s)', async () => {
      await atomic.set('user:u1', { id: 'u1', name: 'Test' }, null);
      const policy = { id: 'pol_cache', name: 'Allow All', effect: 'allow' as const, actions: ['read'], resource: 'sandbox:*', priority: 1000, enabled: true, createdAt: Date.now(), updatedAt: Date.now() };
      await atomic.set('policy:ids', ['pol_cache'], null);
      await atomic.set('policy:pol_cache', policy, null);
      await atomic.set('usergroup:ids', [], null);
      await atomic.set('permgroup:ids', [], null);
      checker.invalidateCache();

      // First check populates cache
      const r1 = await checker.check({ userId: 'u1', action: 'read', resource: 'sandbox:123' }, emptyMacRules);
      expect(r1.allowed).toBe(true);

      // Second check: still within TTL → uses cache, same result
      const r2 = await checker.check({ userId: 'u1', action: 'read', resource: 'sandbox:123' }, emptyMacRules);
      expect(r2.allowed).toBe(true);

      // Invalidate: next check reloads from store
      checker.invalidateCache();
      // Policy still exists in store → still allowed
      const r3 = await checker.check({ userId: 'u1', action: 'read', resource: 'sandbox:123' }, emptyMacRules);
      expect(r3.allowed).toBe(true);
    });

    it('invalidateCache causes fresh reload from store', async () => {
      await atomic.set('user:u1', { id: 'u1', name: 'Test' }, null);
      checker.invalidateCache();

      // No policies → deny
      const r1 = await checker.check({ userId: 'u1', action: 'read', resource: 'sandbox' }, emptyMacRules);
      expect(r1.allowed).toBe(false);

      // Create a second checker on the SAME store (simulating "another instance")
      const checker2 = new PermissionChecker(atomic, new ConsoleLogger());
      // Seed policy through checker2's CRUD path
      await atomic.set('policy:ids', ['pol_new'], null);
      await atomic.set('policy:pol_new', { id: 'pol_new', name: 'New', effect: 'allow', actions: ['read'], resource: 'sandbox', priority: 1000, enabled: true, createdAt: Date.now(), updatedAt: Date.now() }, null);
      checker2.invalidateCache(); // force checker2 to reload

      // checker2 sees the new policy
      const r2 = await checker2.check({ userId: 'u1', action: 'read', resource: 'sandbox' }, emptyMacRules);
      expect(r2.allowed).toBe(true);

      // checker1 still has stale cached empty list
      const r1b = await checker.check({ userId: 'u1', action: 'read', resource: 'sandbox' }, emptyMacRules);
      expect(r1b.allowed).toBe(false); // stale cache

      // After checker1 invalidates, it also sees the policy
      checker.invalidateCache();
      const r3 = await checker.check({ userId: 'u1', action: 'read', resource: 'sandbox' }, emptyMacRules);
      expect(r3.allowed).toBe(true);
    });
  });
});
