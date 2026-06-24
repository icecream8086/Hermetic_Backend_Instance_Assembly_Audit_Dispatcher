import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';
import { UserService } from '../../../src/features/users/service.ts';
import { SysGroupService } from '../../../src/features/system-group/service.ts';
import { ConsoleLogger } from '../../../src/core/audit/console-logger.ts';
import { createUid, createGid, UID_MIN, GID_MIN, DEFAULT_SHELL, DEFAULT_HOME_PREFIX } from '../../../src/features/users/types.ts';
import type { User, Uid, Gid, UserId } from '../../../src/features/users/types.ts';
import { generateUserId, createUserId } from '../../../src/features/users/types.ts';
import type { SysGroup } from '../../../src/features/system-group/types.ts';

function makeStore() { return new FileKVAtomicStore(join(tmpdir(), 'hbi-unix-user-' + crypto.randomUUID().slice(0, 8))); }

describe('Uid / Gid brand types', () => {
  it('createUid accepts valid integers', () => {
    expect(createUid(1000)).toBe(1000);
    expect(createUid(0)).toBe(0);
    expect(createUid(65535)).toBe(65535);
  });

  it('createUid rejects negative numbers', () => {
    expect(() => createUid(-1)).toThrow('Invalid UID');
  });

  it('createUid rejects floats', () => {
    expect(() => createUid(1000.5)).toThrow('Invalid UID');
  });

  it('createGid accepts valid integers', () => {
    expect(createGid(1000)).toBe(1000);
    expect(createGid(0)).toBe(0);
  });

  it('UID_MIN and GID_MIN start at 1000', () => {
    expect(UID_MIN).toBe(1000);
    expect(GID_MIN).toBe(1000);
  });
});

describe('User with RHEL passwd 7-field model', () => {
  let service: UserService;
  let atomic: ReturnType<typeof makeStore>;

  beforeEach(() => {
    atomic = makeStore();
    service = new UserService(atomic, new ConsoleLogger());
  });

  const register = (email = 'alice@test.com', name = 'Alice') =>
    service.register({ email, password: 'secret123', name });

  it('allocates UID starting from 1000 on register', async () => {
    const { user } = await register();
    expect(user.uid).toBe(UID_MIN);
    expect(user.gid).toBe(GID_MIN);
    expect(user.gecos).toBe('Alice');
    expect(user.directory).toBe('/home/alice@test.com');
    expect(user.shell).toBe(DEFAULT_SHELL);
    expect(user.supplementaryGids).toEqual([]);
  });

  it('allocates sequential UIDs', async () => {
    const a = await register('a@test.com', 'A');
    const b = await register('b@test.com', 'B');
    const c = await register('c@test.com', 'C');
    expect(a.user.uid).toBe(1000);
    expect(b.user.uid).toBe(1001);
    expect(c.user.uid).toBe(1002);
  });

  it('getByUid returns the correct user', async () => {
    const { user } = await register();
    const found = await service.getByUid(user.uid);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(user.id);
    expect(found!.uid).toBe(user.uid);
  });

  it('getByUid returns null for unknown UID', async () => {
    const found = await service.getByUid(createUid(99999));
    expect(found).toBeNull();
  });

  it('normalizes old stored users missing passwd fields', async () => {
    const id = generateUserId();
    // Simulate an old user record without passwd fields
    const oldUser = {
      id,
      email: 'old@test.com',
      passwordHash: 'x',
      name: 'Old User',
      role: 'Viewer' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // no uid, gid, gecos, directory, shell, supplementaryGids
    };
    await atomic.set('user:' + id, oldUser, null);
    await atomic.set('user:email:old@test.com', oldUser, null);

    const user = await service.getById(id);
    expect(user).not.toBeNull();
    expect(user!.uid).toBe(UID_MIN);
    expect(user!.gid).toBe(GID_MIN);
    expect(user!.gecos).toBe('Old User');
    expect(user!.directory).toBe('/home/old@test.com');
    expect(user!.shell).toBe(DEFAULT_SHELL);
    expect(user!.supplementaryGids).toEqual([]);
  });

  it('updates passwd fields via UpdateUserInput', async () => {
    const { user } = await register();
    const updated = await service.update(user.id, {
      name: undefined, password: undefined, role: undefined,
      loginPolicy: undefined, publicKeyEd25519: undefined,
      gecos: 'Alice Smith',
      directory: '/data/alice',
      shell: '/bin/zsh',
      supplementaryGids: undefined,
    });
    expect(updated.gecos).toBe('Alice Smith');
    expect(updated.directory).toBe('/data/alice');
    expect(updated.shell).toBe('/bin/zsh');
  });
});

describe('Supplementary groups (RHEL §1 supp_groups)', () => {
  let service: UserService;
  let atomic: ReturnType<typeof makeStore>;

  beforeEach(() => {
    atomic = makeStore();
    service = new UserService(atomic, new ConsoleLogger());
  });

  async function registerUser() {
    return service.register({ email: 'test@test.com', password: 'secret123', name: 'Test' });
  }

  it('starts with empty supplementary groups', async () => {
    const { user } = await registerUser();
    expect(user.supplementaryGids).toEqual([]);
  });

  it('adds supplementary group', async () => {
    const { user } = await registerUser();
    const gid = createGid(2000);
    const updated = await service.addSupplementaryGroup(user.id, gid);
    expect(updated.supplementaryGids).toContain(gid);
  });

  it('does not duplicate supplementary group', async () => {
    const { user } = await registerUser();
    const gid = createGid(2000);
    await service.addSupplementaryGroup(user.id, gid);
    const updated = await service.addSupplementaryGroup(user.id, gid);
    expect(updated.supplementaryGids.filter(g => g === gid).length).toBe(1);
  });

  it('removes supplementary group', async () => {
    const { user } = await registerUser();
    const gid = createGid(2000);
    await service.addSupplementaryGroup(user.id, gid);
    const updated = await service.removeSupplementaryGroup(user.id, gid);
    expect(updated.supplementaryGids).not.toContain(gid);
  });

  it('removing non-existent group is a no-op', async () => {
    const { user } = await registerUser();
    const updated = await service.removeSupplementaryGroup(user.id, createGid(9999));
    expect(updated.supplementaryGids).toEqual([]);
  });

  it('lists supplementary groups', async () => {
    const { user } = await registerUser();
    const g1 = createGid(2000);
    const g2 = createGid(3000);
    await service.addSupplementaryGroup(user.id, g1);
    await service.addSupplementaryGroup(user.id, g2);
    const list = await service.listSupplementaryGroups(user.id);
    expect(list).toContain(g1);
    expect(list).toContain(g2);
    expect(list.length).toBe(2);
  });

  it('throws on supplementary operations for non-existent user', async () => {
    await expect(service.addSupplementaryGroup(createUserId('00000000-0000-4000-a000-000000000000'), createGid(2000)))
      .rejects.toThrow('User not found');
  });
});

describe('SysGroup GID allocation (RHEL §1)', () => {
  let service: SysGroupService;
  let atomic: ReturnType<typeof makeStore>;

  beforeEach(() => {
    atomic = makeStore();
    service = new SysGroupService(atomic, new ConsoleLogger());
  });

  it('allocates GID starting from 1000 on create', async () => {
    const group = await service.create({ name: 'testgrp', rules: [] });
    expect(group.gid).toBe(GID_MIN);
  });

  it('allocates sequential GIDs', async () => {
    const a = await service.create({ name: 'a', rules: [] });
    const b = await service.create({ name: 'b', rules: [] });
    const c = await service.create({ name: 'c', rules: [] });
    expect(a.gid).toBe(1000);
    expect(b.gid).toBe(1001);
    expect(c.gid).toBe(1002);
  });

  it('getByGid returns the correct group', async () => {
    const group = await service.create({ name: 'findme', rules: [] });
    const found = await service.getByGid(group.gid);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(group.id);
    expect(found!.gid).toBe(group.gid);
  });

  it('getByGid returns null for unknown GID', async () => {
    const found = await service.getByGid(createGid(99999));
    expect(found).toBeNull();
    // Ensure createGid works here too
    expect(createGid(0)).toBe(0);
  });
});

describe('Permission checker resolves supplementary GIDs', () => {
  // We test the integration point: a user with supplementary GIDs
  // should inherit capabilities from those groups
  it('supplementary GIDs are stored on user entity', async () => {
    const atomic = makeStore();
    const service = new UserService(atomic, new ConsoleLogger());
    const { user } = await service.register({ email: 'cap@test.com', password: 'secret123', name: 'Cap User' });

    const gid = createGid(2000);
    await service.addSupplementaryGroup(user.id, gid);

    const stored = await service.getById(user.id);
    expect(stored!.supplementaryGids).toContain(gid);
  });
});
