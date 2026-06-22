import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach } from 'vitest';
import { CredentialService, toMasked, maskSecret, type CreateCredentialInput } from '../../../src/core/auth/credential.ts';
import { SecretEncryption } from '../../../src/core/auth/secret-encryption.ts';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';

function store() { return new FileKVAtomicStore(join(tmpdir(), 'hbi-test-' + crypto.randomUUID().slice(0, 8))); }
// 32 bytes of zeros in base64
const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const enc = new SecretEncryption(KEY);

describe('maskSecret', () => {
  it('shows first 6 chars then ***', () => {
    expect(maskSecret('abcdef1234567890')).toBe('abcdef***');
  });

  it('works for strings shorter than 6 chars', () => {
    expect(maskSecret('abc')).toBe('abc***');
  });
});

describe('toMasked', () => {
  it('masks accessKeySecret, token, password, and registryCredentials.password', () => {
    const masked = toMasked({
      id: 'cred_1' as any, name: 'test', type: 'aksk', platform: 'alibaba',
      accessKeyId: 'AK_EXPOSED', accessKeySecret: 'SK_SECRET123', token: 'TOK_SECRET',
      password: 'PW_SECRET',
      registryCredentials: [{ server: 'docker.io', userName: 'u', password: 'REG_PW123' }],
      status: 'active', createdAt: 1, updatedAt: 2,
    });
    expect(masked.accessKeyId).toBe('AK_EXPOSED');
    expect(masked.accessKeySecret).toBe('SK_SEC***');
    expect(masked.token).toBe('TOK_SE***');
    expect(masked.password).toBe('PW_SEC***');
    expect(masked.registryCredentials![0]!.password).toBe('REG_PW***');
  });
});

describe('CredentialService (white-box)', () => {
  let svc: CredentialService;
  const input: CreateCredentialInput = {
    name: 'my-cred', type: 'aksk', platform: 'alibaba',
    accessKeyId: 'AK_TEST', accessKeySecret: 'SK_SECRET',
  };

  beforeEach(() => { svc = new CredentialService(store()); });

  it('create → get roundtrip', async () => {
    const cred = await svc.create(input);
    expect(cred.id).toMatch(/^cred_/);
    expect(cred.accessKeySecret).toBe('SK_SECRET');
    const stored = await svc.get(cred.id);
    expect(stored).not.toBeNull();
    expect(stored!.accessKeySecret).toBe('SK_SECRET');
  });

  it('create → list', async () => {
    await svc.create(input);
    const all = await svc.list();
    expect(all).toHaveLength(1);
  });

  it('list filters by platform', async () => {
    await svc.create({ ...input, name: 'a', platform: 'alibaba' });
    await svc.create({ ...input, name: 'b', platform: 'podman' });
    expect(await svc.list({ platform: 'alibaba' })).toHaveLength(1);
    expect(await svc.list({ platform: 'podman' })).toHaveLength(1);
  });

  it('findByName returns matching credential', async () => {
    await svc.create({ ...input, name: 'unique-name' });
    const found = await svc.findByName('unique-name');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('unique-name');
  });

  it('findByName returns null for non-existent', async () => {
    expect(await svc.findByName('nope')).toBeNull();
  });

  it('update changes fields', async () => {
    const cred = await svc.create(input);
    const updated = await svc.update(cred.id, { accessKeySecret: 'NEW_SK' });
    expect(updated.accessKeySecret).toBe('NEW_SK');
    const stored = await svc.get(cred.id);
    expect(stored!.accessKeySecret).toBe('NEW_SK');
  });

  it('update works correctly with version tracking', async () => {
    const cred = await svc.create(input);
    // Update twice in a row — both should succeed (OCC handles version tracking)
    await svc.update(cred.id, { accessKeySecret: 'SK_V2' });
    const updated = await svc.update(cred.id, { accessKeySecret: 'SK_V3' });
    expect(updated.accessKeySecret).toBe('SK_V3');
    const stored = await svc.get(cred.id);
    expect(stored!.accessKeySecret).toBe('SK_V3');
  });

  it('update throws 404 for non-existent', async () => {
    await expect(svc.update('cred_nope' as any, { accessKeySecret: 'x' })).rejects.toThrow('Credential not found');
  });

  it('delete removes credential', async () => {
    const cred = await svc.create(input);
    await svc.delete(cred.id);
    expect(await svc.get(cred.id)).toBeNull();
  });

  it('delete throws 404 for non-existent', async () => {
    await expect(svc.delete('cred_nope' as any)).rejects.toThrow('Credential not found');
  });
});

describe('CredentialService with encryption (white-box)', () => {
  let svc: CredentialService;
  const input: CreateCredentialInput = {
    name: 'enc-cred', type: 'aksk', platform: 'alibaba',
    accessKeyId: 'AK', accessKeySecret: 'PLAIN_SK', token: 'PLAIN_TOKEN',
    password: 'PLAIN_PW',
    registryCredentials: [{ server: 'docker.io', userName: 'u', password: 'REG_PW' }],
  };

  beforeEach(() => { svc = new CredentialService(store(), enc); });

  it('encrypts secrets at rest in KV', async () => {
    const cred = await svc.create(input);
    // Read raw store entry — should be encrypted (prefixed with $AES$)
    const raw = await svc.atomic.get<any>('cred:' + cred.id);
    expect(raw!.value.accessKeySecret).toMatch(/^\$AES\$/);
    expect(raw!.value.token).toMatch(/^\$AES\$/);
    expect(raw!.value.password).toMatch(/^\$AES\$/);
    expect(raw!.value.registryCredentials[0].password).toMatch(/^\$AES\$/);
  });

  it('decrypts on get', async () => {
    const cred = await svc.create(input);
    const stored = await svc.get(cred.id);
    expect(stored!.accessKeySecret).toBe('PLAIN_SK');
    expect(stored!.token).toBe('PLAIN_TOKEN');
  });

  it('decrypts on list', async () => {
    await svc.create(input);
    const all = await svc.list();
    expect(all[0]!.accessKeySecret).toBe('PLAIN_SK');
  });

  it('decrypts on findByName', async () => {
    await svc.create({ ...input, name: 'find-me' });
    const found = await svc.findByName('find-me');
    expect(found!.accessKeySecret).toBe('PLAIN_SK');
  });
});
