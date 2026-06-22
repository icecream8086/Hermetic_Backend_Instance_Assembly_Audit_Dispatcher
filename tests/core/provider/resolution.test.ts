import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach } from 'vitest';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';
import { InstanceProviderResolver } from '../../../src/core/provider/instance-resolver.ts';
import { InstanceService } from '../../../src/core/region/instance.ts';
import { CredentialService } from '../../../src/core/auth/credential.ts';
import type { CreateInstanceInput } from '../../../src/core/region/instance.ts';
import type { CreateCredentialInput } from '../../../src/core/auth/credential.ts';
import { CredentialResolutionError } from '../../../src/core/provider/errors.ts';

function atomic() { return new FileKVAtomicStore(join(tmpdir(), 'hbi-resolver-' + crypto.randomUUID().slice(0, 8))); }

function alibabaInstanceInput(overrides?: Partial<CreateInstanceInput>): CreateInstanceInput {
  return {
    name: 'ali-eci-test',
    platform: 'alibaba',
    region: 'cn-hangzhou',
    endpoint: 'eci.cn-hangzhou.aliyuncs.com',
    credentialRef: 'cred_eci_test',
    capabilities: { container: true, image: true, group: true },
    ...overrides,
  };
}

describe('InstanceProviderResolver credential resolution', () => {
  let store: ReturnType<typeof atomic>;
  let instanceService: InstanceService;
  let credentialService: CredentialService;
  let resolver: InstanceProviderResolver;

  beforeEach(async () => {
    store = atomic();
    instanceService = new InstanceService(store);
    credentialService = new CredentialService(store);
    resolver = new InstanceProviderResolver(instanceService, credentialService);
  });

  describe('#resolveCredential throws instead of returning undefined', () => {
    it('throws CredentialResolutionError when credentialRef is set but credential not found', async () => {
      // create() generates its own ID — use the returned instance
      const inst = await instanceService.create(alibabaInstanceInput({ credentialRef: 'cred_nonexistent' }));
      await expect(resolver.resolveContainer(inst.id))
        .rejects.toThrow(CredentialResolutionError);
    });

    it('throws CredentialResolutionError when credentialRef is set but credential has no access keys', async () => {
      // Create a credential without accessKeyId/accessKeySecret
      const cred = await credentialService.create({
        name: 'empty_cred',
        type: 'aksk',
        platform: 'alibaba',
      } as CreateCredentialInput);
      const inst = await instanceService.create(alibabaInstanceInput({
        credentialRef: cred.id as string,
        endpoint: 'eci.cn-hangzhou.aliyuncs.com',
      }));
      await expect(resolver.resolveContainer(inst.id))
        .rejects.toThrow(CredentialResolutionError);
    });

    it('CredentialResolutionError includes credentialRef and instanceId', async () => {
      const inst = await instanceService.create(alibabaInstanceInput({
        credentialRef: 'cred_missing',
      }));
      try {
        await resolver.resolveContainer(inst.id);
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(CredentialResolutionError);
        expect((e as CredentialResolutionError).credentialRef).toBe('cred_missing');
        expect((e as CredentialResolutionError).instanceId).toBe(inst.id);
        expect(e.message).toContain('cred_missing');
        expect(e.message).toContain(inst.id);
      }
    });

    it('has statusCode 401 for extraction by handler errorStatus()', async () => {
      const inst = await instanceService.create(alibabaInstanceInput({ credentialRef: 'cred_nonexistent2' }));
      try {
        await resolver.resolveContainer(inst.id);
        expect.fail('expected throw');
      } catch (e) {
        expect((e as any).statusCode).toBe(401);
        expect((e as any).code).toBe('CREDENTIAL_RESOLUTION_FAILED');
      }
    });

    it('resolves successfully when credential exists with valid access keys', async () => {
      const cred = await credentialService.create({
        name: 'valid_cred',
        type: 'aksk',
        platform: 'alibaba',
        accessKeyId: 'ak_test',
        accessKeySecret: 'sk_test',
      } as CreateCredentialInput);
      const inst = await instanceService.create(alibabaInstanceInput({
        credentialRef: cred.id as string,
        endpoint: 'eci.cn-hangzhou.aliyuncs.com',
      }));
      const provider = await resolver.resolveContainer(inst.id);
      expect(provider).toBeDefined();
      expect(typeof provider.create).toBe('function');
    });

    it('falls back to env vars when no credentialRef is set', async () => {
      const prevAk = process.env['ALIBABA_ACCESS_KEY_ID'];
      const prevSk = process.env['ALIBABA_ACCESS_KEY_SECRET'];
      try {
        process.env['ALIBABA_ACCESS_KEY_ID'] = 'env_ak';
        process.env['ALIBABA_ACCESS_KEY_SECRET'] = 'env_sk';
        const inst = await instanceService.create(alibabaInstanceInput({ credentialRef: undefined }));
        const provider = await resolver.resolveContainer(inst.id);
        expect(provider).toBeDefined();
      } finally {
        if (prevAk !== undefined) process.env['ALIBABA_ACCESS_KEY_ID'] = prevAk;
        else delete process.env['ALIBABA_ACCESS_KEY_ID'];
        if (prevSk !== undefined) process.env['ALIBABA_ACCESS_KEY_SECRET'] = prevSk;
        else delete process.env['ALIBABA_ACCESS_KEY_SECRET'];
      }
    });
  });

  describe('resolveContainer', () => {
    it('throws AppError(404) with code INSTANCE_NOT_FOUND when instanceId does not exist', async () => {
      try {
        await resolver.resolveContainer('inst_nonexistent' as any);
        expect.fail('should have thrown');
      } catch (e) {
        expect((e as any).statusCode).toBe(404);
        expect((e as any).code).toBe('INSTANCE_NOT_FOUND');
      }
    });

    it('resolves podman instance without credentials', async () => {
      const inst = await instanceService.create({
        name: 'podman-local',
        platform: 'podman',
        region: 'local',
        endpoint: 'http://127.0.0.1:8080',
        capabilities: { container: true, image: true },
      });
      const provider = await resolver.resolveContainer(inst.id);
      expect(provider).toBeDefined();
      expect(typeof provider.create).toBe('function');
    });

    it('returns StubContainerProvider when no instanceId and no online instances', async () => {
      const provider = await resolver.resolveContainer(undefined);
      expect(provider).toBeDefined();
      const result = await provider.describe({ region: 'local' as any });
      expect(result.sandboxes).toEqual([]);
    });
  });
});
