import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';
import type { IAtomicStore } from '../../../src/core/store/interfaces.ts';
import type { IAuditWriter } from '../../../src/core/audit/types.ts';
import { SecurityResourceService } from '../../../src/core/security/service.ts';
import type { CreateSecurityResourceInput } from '../../../src/core/security/types.ts';
import { createInstanceId } from '../../../src/core/region/instance.ts';
import { verifyToken, base64urlDecode } from '../../../src/core/security/jwt.ts';

function tmpStore(): IAtomicStore {
  return new FileKVAtomicStore(join(tmpdir(), 'hbi-security-test-' + crypto.randomUUID().slice(0, 8)));
}

const noopAudit: IAuditWriter = { write: () => {} };
const testInstanceId = createInstanceId('test-instance');

function makeCreateInput(overrides?: Partial<CreateSecurityResourceInput>): CreateSecurityResourceInput {
  return {
    name: 'test-resource',
    bucketId: 'my-bucket',
    instanceId: testInstanceId,
    tokenTtl: 3600,
    presignedUrlTtl: 300,
    accessPolicy: [{ prefix: 'data/', permissions: ['read', 'write'] }],
    ...overrides,
  };
}

describe('SecurityResourceService', () => {
  let store: IAtomicStore;
  let svc: SecurityResourceService;

  beforeEach(() => {
    store = tmpStore();
    svc = new SecurityResourceService(store, noopAudit);
  });

  afterEach(async () => {
    // Cleanup KV store
    const all = await svc.list();
    for (const r of all) {
      // Use type assertion to call delete — it's public
      await svc.delete(r.id);
    }
  });

  describe('provision', () => {
    it('creates a SecurityResource with default values', async () => {
      const res = await svc.provision(makeCreateInput({ accessPolicy: undefined }));
      expect(res.id).toBeTruthy();
      expect(res.name).toBe('test-resource');
      expect(res.bucketId).toBe('my-bucket');
      expect(res.tokenTtl).toBe(3600);
      expect(res.presignedUrlTtl).toBe(300);
      expect(res.accessPolicy).toHaveLength(1);
      expect(res.accessPolicy[0]!.prefix).toBe('');
      expect(res.status).toBe('Active' as any);
    });

    it('creates a SecurityResource with custom accessPolicy', async () => {
      const res = await svc.provision(makeCreateInput({
        accessPolicy: [
          { prefix: 'public/', permissions: ['read'] },
          { prefix: 'private/', permissions: ['read', 'write'] },
        ],
      }));
      expect(res.accessPolicy).toHaveLength(2);
      expect(res.accessPolicy[1]!.prefix).toBe('private/');
      expect(res.accessPolicy[1]!.permissions).toEqual(['read', 'write']);
    });
  });

  describe('issueToken', () => {
    it('issues a JWT token with merged policies from multiple resources', async () => {
      await svc.provision(makeCreateInput({
        name: 'resource-a',
        bucketId: 'bucket-a',
        accessPolicy: [{ prefix: 'data/', permissions: ['read'] }],
      }));
      await svc.provision(makeCreateInput({
        name: 'resource-b',
        bucketId: 'bucket-b',
        accessPolicy: [{ prefix: 'logs/', permissions: ['read', 'write'] }],
      }));

      const { token, expiresAt } = await svc.issueToken(['resource-a', 'resource-b'], 'sandbox-001');
      expect(token).toBeTruthy();
      expect(token.split('.')).toHaveLength(3);
      expect(expiresAt).toBeTruthy();

      // Verify the token
      const secretEntry = await store.get<string>('_sys:jwt-secret');
      expect(secretEntry?.value).toBeTruthy();
      const secret = base64urlDecode(secretEntry!.value);
      const result = await verifyToken(token, secret);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.claims.sub).toBe('sandbox-001');
        expect(result.claims.iss).toBe('hbi-aad');
        // Should have merged grants from both resources
        const buckets = result.claims.grants.map(g => g.bucket);
        expect(buckets).toContain('bucket-a');
        expect(buckets).toContain('bucket-b');
        expect(result.claims.grants).toHaveLength(2);
      }
    });

    it('throws when a resource is not found', async () => {
      await svc.provision(makeCreateInput({ name: 'exists' }));
      await expect(svc.issueToken(['exists', 'does-not-exist'], 'sandbox-001'))
        .rejects.toThrow('does-not-exist');
    });
  });

  describe('list / getById / getByName', () => {
    it('returns empty list when no resources', async () => {
      const all = await svc.list();
      expect(all).toHaveLength(0);
    });

    it('lists all resources', async () => {
      await svc.provision(makeCreateInput({ name: 'r1' }));
      await svc.provision(makeCreateInput({ name: 'r2' }));
      const all = await svc.list();
      expect(all).toHaveLength(2);
    });

    it('finds resource by name', async () => {
      await svc.provision(makeCreateInput({ name: 'find-me' }));
      const found = await svc.getByName('find-me');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('find-me');
    });
  });

  describe('revoke / delete', () => {
    it('revokes a resource', async () => {
      const res = await svc.provision(makeCreateInput({ name: 'to-revoke' }));
      await svc.revoke(res.id);
      const revoked = await svc.getById(res.id);
      expect(revoked!.status).toBe('Revoked' as any);
    });

    it('deletes a resource', async () => {
      const res = await svc.provision(makeCreateInput({ name: 'to-delete' }));
      await svc.delete(res.id);
      const deleted = await svc.getById(res.id);
      expect(deleted).toBeNull();
    });
  });
});
