import { describe, it, expect } from 'vitest';
import type { IContainerProvider, IContainerGroupProvider } from '../../../src/core/provider/interfaces.ts';
import type { IS3Provider } from '../../../src/core/provider/s3.ts';
import type {
  CreateContainerGroupInput, ContainerGroupRuntime,
  SecretMountConfig, DeleteContainerGroupInput,
  GetContainerLogInput, VolumeConfigInput,
} from '../../../src/core/provider/types.ts';
import { StubContainerProvider } from '../../../src/providers/stub/container.ts';
import { createS3Provider } from '../../../src/core/provider/s3-factory.ts';
import { mapVolumes, mapVolumeMounts, mapEnvVars } from '../../../src/core/provider/mapper.ts';
import { createProviderRegistry } from '../../../src/core/provider/factory.ts';

// ─── 1. Interface contract — compile-time type verification ───

describe('IContainerProvider contract', () => {
  it('all required methods exist on the interface type', () => {
    const methods: (keyof IContainerProvider)[] = [
      'create', 'describe', 'delete', 'getLogs', 'getStatus',
      'stop', 'start', 'restart', 'kill', 'pause', 'unpause',
      'wait', 'exec', 'rename', 'stats', 'top',
    ];
    expect(methods.length).toBeGreaterThanOrEqual(14);
    expect(methods).toContain('create');
    expect(methods).toContain('delete');
    expect(methods).toContain('getStatus');
  });

  it('IS3Provider interface includes presigned URL support', () => {
    const methods: (keyof IS3Provider)[] = [
      'putObject', 'getObject', 'deleteObject', 'headObject', 'listObjects',
      'getPresignedUrl', 'putPresignedUrl',
    ];
    expect(methods).toContain('putObject');
    expect(methods).toContain('getObject');
    expect(methods).toContain('getPresignedUrl');
  });

  it('IContainerGroupProvider includes group-level lifecycle', () => {
    const methods: (keyof IContainerGroupProvider)[] = [
      'createGroup', 'describeGroup', 'deleteGroup', 'stopGroup', 'startGroup',
    ];
    expect(methods).toContain('createGroup');
    expect(methods).toContain('deleteGroup');
  });
});

// ─── 2. Input/output type shape compliance ───

describe('Provider type shapes', () => {
  it('CreateContainerGroupInput accepts all fields including secretMounts', () => {
    const input: CreateContainerGroupInput = {
      name: 'test-sandbox', region: 'local' as any,
      cpu: 1, memory: 512, spotStrategy: 'None', restartPolicy: 'Always',
      containers: [{
        name: 'main', image: 'nginx:latest',
        env: [{ name: 'ENV', value: 'prod' }],
        resources: { limits: { cpu: 1, memory: 512 } },
        ports: [{ containerPort: 80 }],
        volumeMounts: [{ volumeId: 'vol_1', mountPath: '/data' }],
        livenessProbe: { httpGet: { path: '/healthz', port: 8080 } },
      }],
      volumes: [{ id: 'vol_1', type: 'NFSVolume', options: { server: 'nfs://10.0.0.1', path: '/export' } }],
      network: { allocatePublicIp: true },
      secretMounts: [{ mountPath: '/run/secrets/db-pass', data: 's3cret!', mode: 0o600 }],
    };
    expect(input.secretMounts).toHaveLength(1);
    expect(input.secretMounts![0]!.mountPath).toBe('/run/secrets/db-pass');
    expect(input.secretMounts![0]!.data).toBe('s3cret!');
    expect(input.secretMounts![0]!.mode).toBe(0o600);
  });

  it('ContainerGroupRuntime includes health status', () => {
    const runtime: ContainerGroupRuntime = {
      providerId: 'prov_abc', name: 'test', status: 'Running',
      regionId: 'cn-hangzhou' as any, zoneId: 'cn-hangzhou-f' as any,
      instanceType: 'ecs.g6.large', spotStrategy: 'None',
      cpu: 2, memory: 4096,
      network: { privateIp: '10.0.0.1', vpcId: 'vpc-xxx' },
      associatedResources: [], restartPolicy: 'Always',
      containers: [{
        id: 'c1' as any, name: 'main', image: 'nginx:latest',
        state: { state: 'Running' as const, ready: true, restartCount: 0, startTime: '2026-01-01T00:00:00Z' },
        cpu: 1, memory: 256, volumeMounts: [],
        health: { status: 'healthy' as const },
      }],
      volumes: [], events: [], tags: [],
    };
    expect(runtime.containers[0]!.state.ready).toBe(true);
    expect(runtime.containers[0]!.health!.status).toBe('healthy');
  });

  it('SecretMountConfig optional mode', () => {
    const sm: SecretMountConfig = { mountPath: '/run/secrets/key', data: 'data', mode: 0o400 };
    expect(sm.mode).toBe(0o400);
    const sm2: SecretMountConfig = { mountPath: '/run/secrets/x', data: 'x' };
    expect(sm2.mode).toBeUndefined();
  });
});

// ─── 3. StubContainerProvider baseline ───

describe('StubContainerProvider baseline', () => {
  function baseInput(): CreateContainerGroupInput {
    return {
      name: 'stub-test', region: 'local' as any,
      cpu: 1, memory: 512, spotStrategy: 'None', restartPolicy: 'Always',
      containers: [{ name: 'main', image: 'alpine:latest' }],
      network: { allocatePublicIp: false },
    } as CreateContainerGroupInput;
  }

  it('create → describe → delete', async () => {
    const p = new StubContainerProvider();
    const { providerId } = await p.create(baseInput());
    expect(providerId).toMatch(/^stub-eci-/);
    expect((await p.describe({ sandboxId: providerId as any })).sandboxes).toHaveLength(1);
    await p.delete({ region: 'local' as any, providerId });
    expect((await p.describe({ sandboxName: 'stub-test' })).sandboxes).toHaveLength(0);
  });

});

// ─── 4. S3 provider factory dispatch ───

describe('S3 provider factory', () => {
  it('dispatches by type', () => {
    expect(createS3Provider('aws-s3', 'us-east-1', { sigV4: { accessKeyId: 'admin', secretAccessKey: 'admin' } }).type).toBe('aws-s3');
    expect(createS3Provider('alibaba-oss', 'cn-hangzhou', { oss: { accessKeyId: 'ak', accessKeySecret: 'sk' } }).type).toBe('alibaba-oss');
  });

  it('throws on missing credentials', () => {
    expect(() => createS3Provider('aws-s3', 'us-east-1', {} as any)).toThrow('SigV4');
    expect(() => createS3Provider('alibaba-oss', 'cn-hangzhou', {} as any)).toThrow('OSS');
  });
});

// ─── 5. Mapper functions ───

describe('Provider mapper', () => {
  it('mapVolumes handles all types', () => {
    const result = mapVolumes([
      { id: 'v1', type: 'NFSVolume', nfs: { server: 'nfs://srv', path: '/data', readOnly: false } },
      { id: 'v2', type: 'DiskVolume', disk: { diskId: 'd-xxx', fsType: 'ext4', readOnly: true, deleteWithInstance: true } },
      { id: 'v3', type: 'SecretVolume', secret: { name: 'db-pass' } },
    ] as any);
    expect(result).toHaveLength(3);
    expect(result![0]!.type).toBe('NFSVolume');
    expect(result![1]!.options!.diskId).toBe('d-xxx');
    expect(result![2]!.options!.name).toBe('db-pass');
  });

  it('mapVolumes returns undefined for empty', () => {
    expect(mapVolumes(undefined)).toBeUndefined();
    expect(mapVolumes([])).toBeUndefined();
  });

  it('mapEnvVars preserves name/value', () => {
    expect(mapEnvVars([{ name: 'A', value: '1' }, { name: 'B', value: '2' }])).toEqual([{ name: 'A', value: '1' }, { name: 'B', value: '2' }]);
  });

  it('mapVolumeMounts preserves credentialRef', () => {
    const result = mapVolumeMounts([
      { volumeId: 'v1', mountPath: '/data', readOnly: false },
      { volumeId: 'v2', mountPath: '/secret', readOnly: true, credentialRef: 'my-cred' },
    ]);
    expect(result![1]!.credentialRef).toBe('my-cred');
  });

  it('mapVolumeMounts returns undefined for empty', () => {
    expect(mapVolumeMounts([])).toBeUndefined();
  });
});

// ─── 6. Provider registry dispatch ───

describe('ProviderRegistry dispatch', () => {
  it('createProviderRegistry returns a functional registry', () => {
    const reg = createProviderRegistry(
      { container: 'stub', region: 'cn-hangzhou' as any, accounts: [], defaultAccount: 'default', dns: 'stub', metrics: 'stub' } as any,
      { backend: 'none', region: 'auto', accounts: [], defaultAccount: 'default' },
    );
    expect(typeof reg.resolveContainer).toBe('function');
    expect(typeof reg.container).toBe('object');
  });
});
