import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';
import { S3PolicyManager } from '../../../src/core/s3-policy/manager.ts';
import { toMinioPolicy, toOssPolicy } from '../../../src/core/s3-policy/translate.ts';

function createStore(): FileKVAtomicStore {
  const dir = mkdtempSync(join(tmpdir(), 's3-policy-test-'));
  return { dir, store: new FileKVAtomicStore(dir) } as any;
}

describe('S3PolicyManager (white-box)', () => {
  let dir: string;
  let manager: S3PolicyManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 's3-policy-test-'));
    manager = new S3PolicyManager(new FileKVAtomicStore(dir));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates and retrieves a policy', async () => {
    const policy = await manager.create('bkt_1', {
      name: 'read-static',
      effect: 'Allow',
      actions: ['s3:GetObject'],
      pathPrefix: 'static/',
    });
    expect(policy.id).toMatch(/^sp_/);
    expect(policy.bucketId).toBe('bkt_1');
    expect(policy.effect).toBe('Allow');
    expect(policy.pathPrefix).toBe('static/');
    expect(policy.applyToAutoKeys).toBe(true);
    expect(policy.priority).toBe(100);

    const got = await manager.get(policy.id);
    expect(got).not.toBeNull();
    expect(got!.name).toBe('read-static');
  });

  it('lists policies filtered by bucketId', async () => {
    await manager.create('bkt_1', { name: 'p1', effect: 'Allow', actions: ['s3:GetObject'] });
    await manager.create('bkt_1', { name: 'p2', effect: 'Allow', actions: ['s3:PutObject'] });
    await manager.create('bkt_2', { name: 'p3', effect: 'Allow', actions: ['*'] });

    const b1 = await manager.list('bkt_1');
    expect(b1).toHaveLength(2);

    const all = await manager.list();
    expect(all).toHaveLength(3);
  });

  it('updates a policy in-place', async () => {
    const p = await manager.create('bkt_1', { name: 'old', effect: 'Allow', actions: ['s3:GetObject'] });
    const updated = await manager.update(p.id, { name: 'new-name', effect: 'Deny' });
    expect(updated.name).toBe('new-name');
    expect(updated.effect).toBe('Deny');
    expect(updated.actions).toEqual(['s3:GetObject']); // unchanged
  });

  it('deletes a policy', async () => {
    const p = await manager.create('bkt_1', { name: 'del', effect: 'Allow', actions: ['s3:GetObject'] });
    await manager.delete(p.id);
    const got = await manager.get(p.id);
    expect(got).toBeNull();
  });

  it('throws on delete non-existent policy', async () => {
    await expect(manager.delete('sp_nonexistent')).rejects.toThrow('S3 policy not found');
  });

  it('throws on update non-existent policy', async () => {
    await expect(manager.update('sp_nonexistent', { name: 'x' })).rejects.toThrow('S3 policy not found');
  });

  describe('resolve()', () => {
    it('returns null when no auto-key policies', async () => {
      const p = await manager.create('bkt_1', { name: 'manual', effect: 'Allow', actions: ['*'], applyToAutoKeys: false });
      const resolved = await manager.resolve('bkt_1');
      expect(resolved).toBeNull();
    });

    it('returns highest-priority Allow policy', async () => {
      await manager.create('bkt_1', { name: 'low', effect: 'Allow', actions: ['s3:GetObject'], pathPrefix: 'static/', priority: 50 });
      await manager.create('bkt_1', { name: 'high', effect: 'Allow', actions: ['s3:PutObject'], pathPrefix: 'saves/', priority: 100 });
      const r = await manager.resolve('bkt_1');
      expect(r).not.toBeNull();
      expect(r!.effect).toBe('Allow');
      expect(r!.actions).toContain('s3:PutObject');
      expect(r!.pathPrefix).toBe('saves/');
    });

    it('Deny overrides Allow regardless of priority', async () => {
      await manager.create('bkt_1', { name: 'allow-all', effect: 'Allow', actions: ['*'], priority: 200 });
      await manager.create('bkt_1', { name: 'deny-config', effect: 'Deny', actions: ['*'], pathPrefix: 'config/', priority: 50 });
      const r = await manager.resolve('bkt_1');
      expect(r!.effect).toBe('Deny');
      expect(r!.pathPrefix).toBe('config/');
    });

    it('returns null for a different bucket', async () => {
      await manager.create('bkt_1', { name: 'p', effect: 'Allow', actions: ['*'] });
      const r = await manager.resolve('bkt_2');
      expect(r).toBeNull();
    });
  });
});

describe('toMinioPolicy', () => {
  it('generates Allow all policy', () => {
    const policies = [{ effect: 'Allow' as const, actions: ['*'], pathPrefix: '' } as any];
    const parsed = JSON.parse(toMinioPolicy(policies, 'my-bucket'));
    expect(parsed.Version).toBe('2012-10-17');
    expect(parsed.Statement[0].Effect).toBe('Allow');
    expect(parsed.Statement[0].Action).toEqual(['*']);
    expect(parsed.Statement[0].Resource).toContain('arn:aws:s3:::my-bucket/*');
  });

  it('merges multiple policies by effect', () => {
    const policies = [
      { effect: 'Allow' as const, actions: ['s3:GetObject'], pathPrefix: 'public/' },
      { effect: 'Allow' as const, actions: ['s3:PutObject'], pathPrefix: 'uploads/' },
    ];
    const parsed = JSON.parse(toMinioPolicy(policies, 'bucket'));
    const stmt = parsed.Statement[0];
    expect(stmt.Action).toContain('s3:GetObject');
    expect(stmt.Action).toContain('s3:PutObject');
    expect(stmt.Resource).toContain('arn:aws:s3:::bucket/public/*');
    expect(stmt.Resource).toContain('arn:aws:s3:::bucket/uploads/*');
  });

  it('generates valid JSON', () => {
    const policies = [
      { effect: 'Allow' as const, actions: ['s3:GetObject'], pathPrefix: 'static/' },
    ];
    const parsed = JSON.parse(toMinioPolicy(policies, 'b'));
    expect(parsed.Version).toBe('2012-10-17');
    expect(parsed.Statement).toHaveLength(1);
  });
});

describe('toOssPolicy', () => {
  it('generates OSS RAM policy', () => {
    const policies = [{ effect: 'Allow' as const, actions: ['oss:GetObject'], pathPrefix: '' }];
    const parsed = JSON.parse(toOssPolicy(policies, 'my-oss-bucket'));
    expect(parsed.Statement[0].Effect).toBe('Allow');
    expect(parsed.Statement[0].Resource).toContain('acs:oss:*:*:my-oss-bucket/*');
  });

  it('uses version "1" for OSS', () => {
    const policies = [{ effect: 'Allow' as const, actions: ['*'], pathPrefix: '' }];
    const parsed = JSON.parse(toOssPolicy(policies, 'b'));
    expect(parsed.Version).toBe('1');
  });
});
