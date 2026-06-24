import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach } from 'vitest';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';
import { GroupManager } from '../../../src/features/permission/group-manager.ts';
import { ConsoleLogger } from '../../../src/core/audit/console-logger.ts';
import { generateUserGroupId, generatePermGroupId } from '../../../src/features/permission/types.ts';

function store() { return new FileKVAtomicStore(join(tmpdir(), 'hbi-gm-' + crypto.randomUUID().slice(0, 8))); }

describe('GroupManager', () => {
  let mgr: GroupManager;
  let atomic: ReturnType<typeof store>;

  beforeEach(() => {
    atomic = store();
    mgr = new GroupManager(atomic, new ConsoleLogger());
  });

  describe('user groups', () => {
    it('creates and retrieves a user group', async () => {
      const g = await mgr.createUserGroup({ name: 'Devs', memberIds: ['u1', 'u2'] });
      expect(g.name).toBe('Devs');
      expect(g.memberIds).toContain('u1');

      const found = await mgr.ugStore.get(g.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Devs');
    });

    it('defaults adminIds to actor user when not provided', async () => {
      const g = await mgr.createUserGroup({ name: 'Admins' }, { userId: 'admin1' });
      expect(g.adminIds).toContain('admin1');
    });

    it('dependsOn creates parent relationship', async () => {
      const parent = await mgr.createUserGroup({ name: 'Parent' });
      const child = await mgr.createUserGroup({ name: 'Child', dependsOn: [parent.id] });
      expect(child.dependsOn).toContain(parent.id);
    });

    it('lists all user groups', async () => {
      await mgr.createUserGroup({ name: 'G1' });
      await mgr.createUserGroup({ name: 'G2' });
      const all = await mgr.listUserGroups();
      expect(all).toHaveLength(2);
    });

    it('updates a user group', async () => {
      const g = await mgr.createUserGroup({ name: 'Old' });
      const updated = await mgr.updateUserGroup(g.id, { name: 'New' });
      expect(updated.name).toBe('New');
    });

    it('deletes a user group', async () => {
      const g = await mgr.createUserGroup({ name: 'ToDelete' });
      await mgr.deleteUserGroup(g.id);
      const found = await mgr.ugStore.get(g.id);
      expect(found).toBeNull();
    });
  });

  describe('permission groups', () => {
    it('creates and retrieves a permission group with rules', async () => {
      const pg = await mgr.createPermGroup({
        name: 'Read Access',
        userGroupIds: ['ug1'],
        rules: [{ effect: 'allow', actions: ['read'], resource: 'sandbox' }],
      });
      expect(pg.name).toBe('Read Access');
      expect(pg.rules).toHaveLength(1);
      expect(pg.rules[0]!.effect).toBe('allow');

      const found = await mgr.pgStore.get(pg.id);
      expect(found).not.toBeNull();
    });

    it('lists all permission groups', async () => {
      await mgr.createPermGroup({ name: 'PG1', rules: [] });
      await mgr.createPermGroup({ name: 'PG2', rules: [] });
      const all = await mgr.listPermGroups();
      expect(all).toHaveLength(2);
    });

    it('updates a permission group', async () => {
      const pg = await mgr.createPermGroup({ name: 'Old', rules: [] });
      const updated = await mgr.updatePermGroup(pg.id, { name: 'New' });
      expect(updated.name).toBe('New');
    });

    it('deletes a permission group', async () => {
      const pg = await mgr.createPermGroup({ name: 'ToDelete', rules: [] });
      await mgr.deletePermGroup(pg.id);
      const found = await mgr.pgStore.get(pg.id);
      expect(found).toBeNull();
    });
  });

  describe('compare', () => {
    it('detects members present in both user groups', async () => {
      const g1 = await mgr.createUserGroup({ name: 'G1', memberIds: ['u1', 'u2'] });
      const g2 = await mgr.createUserGroup({ name: 'G2', memberIds: ['u1'] });
      const result = await mgr.compareUserGroups(g1.id, g2.id);
      expect(result.common).toBeDefined();
      expect(result.onlyA).toBeDefined();
      expect(result.onlyB).toBeDefined();
      // u1 is in both, u2 only in g1
      expect(result.common.some((r: any) => r.id === 'u1')).toBe(true);
      expect(result.onlyA.some((r: any) => r.id === 'u2')).toBe(true);
    });

    it('detects rules present in both permission groups', async () => {
      const rule = { effect: 'allow' as const, actions: ['read'], resource: 'sandbox' };
      const pg1 = await mgr.createPermGroup({ name: 'PG1', rules: [rule] });
      const pg2 = await mgr.createPermGroup({ name: 'PG2', rules: [rule, { effect: 'deny' as const, actions: ['*'], resource: '*' }] });
      const result = await mgr.comparePermGroups(pg1.id, pg2.id);
      expect(result.common.length).toBeGreaterThanOrEqual(1);
      expect(result.onlyB.length).toBeGreaterThanOrEqual(1);
    });
  });
});
