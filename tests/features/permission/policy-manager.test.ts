import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach } from 'vitest';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';
import { PolicyManager } from '../../../src/features/permission/policy-manager.ts';
import { ConsoleLogger } from '../../../src/core/logger/console-logger.ts';

function store() { return new FileKVAtomicStore(join(tmpdir(), 'hbi-pm-' + crypto.randomUUID().slice(0, 8))); }

describe('PolicyManager', () => {
  let mgr: PolicyManager;
  let atomic: ReturnType<typeof store>;

  beforeEach(() => {
    atomic = store();
    mgr = new PolicyManager(atomic, new ConsoleLogger());
  });

  it('creates and retrieves a policy', async () => {
    const p = await mgr.create({
      name: 'Allow Read', effect: 'allow', actions: ['read'], resource: 'sandbox', priority: 100,
    });
    expect(p.name).toBe('Allow Read');
    expect(p.effect).toBe('allow');

    const found = await mgr.get(p.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Allow Read');
  });

  it('lists all policies', async () => {
    await mgr.create({ name: 'P1', effect: 'allow', actions: ['read'], resource: 'sandbox' });
    await mgr.create({ name: 'P2', effect: 'deny', actions: ['*'], resource: '*' });
    const all = await mgr.list();
    expect(all).toHaveLength(2);
  });

  it('updates a policy', async () => {
    const p = await mgr.create({ name: 'Old', effect: 'allow', actions: ['read'], resource: 'sandbox' });
    const updated = await mgr.update(p.id, { name: 'New' });
    expect(updated.name).toBe('New');
  });

  it('deletes a policy', async () => {
    const p = await mgr.create({ name: 'ToDelete', effect: 'allow', actions: ['read'], resource: 'sandbox' });
    await mgr.delete(p.id);
    const found = await mgr.get(p.id);
    expect(found).toBeNull();
  });

  it('updating enabled field toggles policy', async () => {
    const p = await mgr.create({ name: 'Toggle', effect: 'allow', actions: ['read'], resource: 'sandbox' });
    // Update to disable
    const disabled = await mgr.update(p.id, { enabled: false });
    expect(disabled.enabled).toBe(false);
    // Update to re-enable
    const enabled = await mgr.update(p.id, { enabled: true });
    expect(enabled.enabled).toBe(true);
  });

  it('listPaginated returns correct pages', async () => {
    for (let i = 0; i < 5; i++) await mgr.create({ name: `P${i}`, effect: 'allow', actions: ['read'], resource: 'sandbox' });
    const page1 = await mgr.listPaginated(1, 2);
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);
  });
});
