import { describe, it, expect } from 'vitest';
import { applyTemplate, mapStorage } from '../../../src/features/template/applicator.ts';
import type { SandboxTemplate } from '../../../src/features/template/types.ts';

// ─── Helper ───

function minimalTpl(overrides?: Partial<SandboxTemplate>): SandboxTemplate {
  return {
    id: 'tpl_test',
    name: 'test-template',
    apiVersion: 'hbi-aad/v1',
    kind: 'Container',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    container: { region: 'local' as any, containers: [{ name: 'app', image: 'nginx:latest' }] },
    ...overrides,
  } as SandboxTemplate;
}

// ─── applyTemplate ───

describe('applyTemplate', async () => {
  it('maps name and region', async () => {
    const r = await applyTemplate(minimalTpl(), 'my-sandbox', 'cn-hangzhou');
    expect(r.name).toBe('my-sandbox');
    expect(r.region).toBe('cn-hangzhou');
  });

  it('defaults name to template.name when not overridden', async () => {
    const r = await applyTemplate(minimalTpl());
    expect(r.name).toBe('test-template');
  });

  it('defaults region to container.region', async () => {
    const r = await applyTemplate(minimalTpl());
    expect(r.region).toBe('local');
  });

  it('defaults spotStrategy to None', async () => {
    const r = await applyTemplate(minimalTpl());
    expect(r.spotStrategy).toBe('None');
  });

  it('defaults restartPolicy to Always', async () => {
    const r = await applyTemplate(minimalTpl());
    expect(r.restartPolicy).toBe('Always');
  });

  it('computes cpu sum from container limits', async () => {
    const r = await applyTemplate(minimalTpl({
      container: {
        region: 'local' as any,
        containers: [
          { name: 'a', image: 'a', resources: { limits: { cpu: 2 } } },
          { name: 'b', image: 'b', resources: { limits: { cpu: 3 } } },
        ],
      },
    }));
    expect(r.resourceSpec.cpu).toBe(5);
  });

  it('computes cpu as 1 per container when no resources set', async () => {
    const r = await applyTemplate(minimalTpl({
      container: {
        region: 'local' as any,
        containers: [
          { name: 'a', image: 'a' },
          { name: 'b', image: 'b' },
        ],
      },
    }));
    expect(r.resourceSpec.cpu).toBe(2);
  });

  it('computes memory sum from container limits', async () => {
    const r = await applyTemplate(minimalTpl({
      container: {
        region: 'local' as any,
        containers: [
          { name: 'a', image: 'a', resources: { limits: { memory: 1024 } } },
          { name: 'b', image: 'b', resources: { limits: { memory: 2048 } } },
        ],
      },
    }));
    expect(r.resourceSpec.memory).toBe(3072);
  });

  it('defaults memory to 512 per container', async () => {
    const r = await applyTemplate(minimalTpl({
      container: {
        region: 'local' as any,
        containers: [{ name: 'a', image: 'a' }, { name: 'b', image: 'b' }],
      },
    }));
    expect(r.resourceSpec.memory).toBe(1024);
  });

  it('maps container name and image', async () => {
    const r = await applyTemplate(minimalTpl());
    expect(r.containers).toHaveLength(1);
    expect(r.containers[0]!.name).toBe('app');
    expect(r.containers[0]!.image).toBe('nginx:latest');
  });

  it('maps container command and args', async () => {
    const r = await applyTemplate(minimalTpl({
      container: {
        region: 'local' as any,
        containers: [{ name: 'c', image: 'i', command: ['/bin/sh'], args: ['-c', 'echo hi'] }],
      },
    }));
    expect(r.containers[0]!.command).toEqual(['/bin/sh']);
    expect(r.containers[0]!.args).toEqual(['-c', 'echo hi']);
  });

  it('maps container env with value', async () => {
    const r = await applyTemplate(minimalTpl({
      container: {
        region: 'local' as any,
        containers: [{ name: 'c', image: 'i', env: [{ name: 'FOO', value: 'bar' }] }],
      },
    }));
    expect(r.containers[0]!.env).toEqual([{ name: 'FOO', value: 'bar' }]);
  });

  it('maps container env with valueFrom', async () => {
    const r = await applyTemplate(minimalTpl({
      container: {
        region: 'local' as any,
        containers: [{ name: 'c', image: 'i', env: [{ name: 'POD_IP', valueFrom: 'status.podIP' }] }],
      },
    }));
    expect(r.containers[0]!.env).toEqual([{ name: 'POD_IP', valueFrom: 'status.podIP' }]);
  });

  it('maps container ports', async () => {
    const r = await applyTemplate(minimalTpl({
      container: {
        region: 'local' as any,
        containers: [{ name: 'c', image: 'i', ports: [{ containerPort: 80, protocol: 'tcp' }] }],
      },
    }));
    expect(r.containers[0]!.ports).toEqual([{ containerPort: 80, protocol: 'tcp' }]);
  });

  it('defaults port protocol when not set', async () => {
    const r = await applyTemplate(minimalTpl({
      container: {
        region: 'local' as any,
        containers: [{ name: 'c', image: 'i', ports: [{ containerPort: 8080 }] }],
      },
    }));
    expect(r.containers[0]!.ports).toEqual([{ containerPort: 8080 }]);
  });

  it('maps container resources requests and limits', async () => {
    const r = await applyTemplate(minimalTpl({
      container: {
        region: 'local' as any,
        containers: [{
          name: 'c', image: 'i',
          resources: { requests: { cpu: 1, memory: 512 }, limits: { cpu: 2, memory: 1024, gpu: 1 } },
        }],
      },
    }));
    expect(r.containers[0]!.resources).toEqual({
      requests: { cpu: 1, memory: 512 },
      limits: { cpu: 2, memory: 1024, gpu: 1 },
    });
  });

  it('maps initContainers', async () => {
    const r = await applyTemplate(minimalTpl({
      container: {
        region: 'local' as any,
        containers: [{ name: 'app', image: 'nginx' }],
        initContainers: [{ name: 'init-db', image: 'busybox', command: ['init'] }],
      },
    }));
    expect(r.initContainers).toHaveLength(1);
    expect(r.initContainers![0]!.name).toBe('init-db');
    expect(r.initContainers![0]!.image).toBe('busybox');
    expect(r.initContainers![0]!.command).toEqual(['init']);
  });

  it('maps instanceId from container spec', async () => {
    const r = await applyTemplate(minimalTpl({
      container: { region: 'local' as any, containers: [{ name: 'c', image: 'i' }], instanceId: 'inst_xxx' as any },
    }));
    expect(r.instanceId).toBe('inst_xxx');
  });

  it('maps description', async () => {
    const r = await applyTemplate(minimalTpl({ description: 'My template' }));
    expect(r.description).toBe('My template');
  });
});

// ─── Health checks ───

describe('applyTemplate health checks', async () => {
  it('maps livenessProbe to container', async () => {
    const r = await applyTemplate(minimalTpl({
      container: { region: 'local' as any, containers: [{ name: 'web', image: 'nginx' }] },
      healthChecks: [{
        name: 'web-live', target: 'container:web', type: 'liveness',
        probe: { httpGet: { path: '/health', port: 80 } },
        periodSeconds: 15, timeoutSeconds: 5,
      }],
    }));
    const c = r.containers[0]!;
    expect(c.livenessProbe).toBeDefined();
    expect(c.livenessProbe!.httpGet).toEqual({ path: '/health', port: 80 });
    expect(c.livenessProbe!.periodSeconds).toBe(15);
    expect(c.livenessProbe!.timeoutSeconds).toBe(5);
  });

  it('maps readinessProbe and startupProbe simultaneously', async () => {
    const r = await applyTemplate(minimalTpl({
      container: { region: 'local' as any, containers: [{ name: 'web', image: 'nginx' }] },
      healthChecks: [
        { name: 'ready', target: 'container:web', type: 'readiness', probe: { httpGet: { path: '/ready', port: 80 } } },
        { name: 'start', target: 'container:web', type: 'startup', probe: { tcpSocket: { port: 80 } } },
      ],
    }));
    const c = r.containers[0]!;
    expect(c.readinessProbe).toBeDefined();
    expect(c.startupProbe).toBeDefined();
    expect(c.startupProbe!.tcpSocket).toEqual({ port: 80 });
  });

  it('maps exec probe', async () => {
    const r = await applyTemplate(minimalTpl({
      container: { region: 'local' as any, containers: [{ name: 'db', image: 'mysql' }] },
      healthChecks: [{
        name: 'ping', target: 'container:db', type: 'liveness',
        probe: { exec: { command: ['mysqladmin', 'ping'] } },
      }],
    }));
    expect(r.containers[0]!.livenessProbe!.exec!.command).toEqual(['mysqladmin', 'ping']);
  });

  it('maps probes to initContainers', async () => {
    const r = await applyTemplate(minimalTpl({
      container: {
        region: 'local' as any,
        containers: [{ name: 'app', image: 'nginx' }],
        initContainers: [{ name: 'init-check', image: 'busybox' }],
      },
      healthChecks: [{
        name: 'init-probe', target: 'init:init-check', type: 'readiness',
        probe: { exec: { command: ['check'] } },
      }],
    }));
    expect(r.initContainers![0]!.readinessProbe).toBeDefined();
    expect(r.initContainers![0]!.readinessProbe!.exec!.command).toEqual(['check']);
  });

  it('handles successThreshold and failureThreshold', async () => {
    const r = await applyTemplate(minimalTpl({
      container: { region: 'local' as any, containers: [{ name: 'web', image: 'nginx' }] },
      healthChecks: [{
        name: 'probe', target: 'container:web', type: 'liveness',
        probe: { httpGet: { path: '/', port: 80 } },
        initialDelaySeconds: 5, successThreshold: 3, failureThreshold: 5,
      }],
    }));
    expect(r.containers[0]!.livenessProbe!.initialDelaySeconds).toBe(5);
    expect(r.containers[0]!.livenessProbe!.successThreshold).toBe(3);
    expect(r.containers[0]!.livenessProbe!.failureThreshold).toBe(5);
  });
});

// ─── Network mapping ───

describe('applyTemplate network', async () => {
  it('defaults allocatePublicIp to false when network undefined', async () => {
    const r = await applyTemplate(minimalTpl({ network: undefined }));
    expect((r.network as any).allocatePublicIp).toBe(false);
  });

  it('maps publicIp.allocate', async () => {
    const r = await applyTemplate(minimalTpl({ network: { publicIp: { allocate: true } } }));
    expect((r.network as any).allocatePublicIp).toBe(true);
  });

  it('maps publicIp.bandwidth', async () => {
    const r = await applyTemplate(minimalTpl({ network: { publicIp: { allocate: true, bandwidth: 100 } } }));
    expect((r.network as any).publicIpBandwidth).toBe(100);
  });

  it('maps vpc securityGroupId (system UID)', async () => {
    const r = await applyTemplate(minimalTpl({ network: { vpc: { securityGroupId: 'sg_xxx' } } }));
    expect((r.network as any).securityGroupId).toBe('sg_xxx');
  });

  it('maps vpc subnetIds', async () => {
    const r = await applyTemplate(minimalTpl({ network: { vpc: { subnetIds: ['vsw-a', 'vsw-b'] } } }));
    expect((r.network as any).subnetIds).toEqual(['vsw-a', 'vsw-b']);
  });

  it('maps vpc instanceId', async () => {
    const r = await applyTemplate(minimalTpl({ network: { vpc: { instanceId: 'inst_xxx' as any } } }));
    expect((r.network as any).instanceId).toBe('inst_xxx');
  });

  it('combines publicIp and vpc settings', async () => {
    const r = await applyTemplate(minimalTpl({
      network: {
        publicIp: { allocate: true, bandwidth: 50 },
        vpc: { securityGroupId: 'sg_abc', subnetIds: ['vsw-1'] },
      },
    }));
    expect((r.network as any).allocatePublicIp).toBe(true);
    expect((r.network as any).publicIpBandwidth).toBe(50);
    expect((r.network as any).securityGroupId).toBe('sg_abc');
    expect((r.network as any).subnetIds).toEqual(['vsw-1']);
  });
});

// ─── Storage ───

describe('mapStorage', async () => {
  it('returns empty arrays for undefined storage', async () => {
    const r = await mapStorage(undefined);
    expect(r.volumes).toEqual([]);
    expect(r.volumeMounts).toEqual([]);
  });

  it('returns empty arrays for empty storage', async () => {
    const r = await mapStorage([]);
    expect(r.volumes).toEqual([]);
    expect(r.volumeMounts).toEqual([]);
  });

  it('maps NFS storage', async () => {
    const r = await mapStorage([{
      name: 'data', type: 'nfs', mountPath: '/mnt/data',
      nfs: { server: '192.168.1.1', path: '/exports/data' },
    }]);
    expect(r.volumes).toHaveLength(1);
    expect(r.volumes[0]!.type).toBe('NFSVolume');
    expect(r.volumes[0]!.nfs!.server).toBe('192.168.1.1');
    expect(r.volumes[0]!.nfs!.path).toBe('/exports/data');
    expect(r.volumeMounts).toHaveLength(1);
    expect(r.volumeMounts[0]!.mountPath).toBe('/mnt/data');
    expect(r.volumeMounts[0]!.readOnly).toBe(false);
  });

  it('maps NFS with readOnly flag', async () => {
    const r = await mapStorage([{
      name: 'ro-data', type: 'nfs', mountPath: '/ro',
      nfs: { server: 's', path: '/p', readOnly: true },
    }]);
    expect(r.volumes[0]!.nfs!.readOnly).toBe(true);
    expect(r.volumeMounts[0]!.readOnly).toBe(true);
  });

  it('skips NFS when nfs config is missing', async () => {
    const r = await mapStorage([{ name: 'broken', type: 'nfs', mountPath: '/x' } as any]);
    expect(r.volumes).toHaveLength(0);
  });

  it('maps hostPath storage', async () => {
    const r = await mapStorage([{ name: 'local', type: 'hostPath', mountPath: '/cache' }]);
    expect(r.volumes).toHaveLength(1);
    expect(r.volumes[0]!.type).toBe('HostPathVolume');
    expect(r.volumeMounts[0]!.mountPath).toBe('/cache');
  });

  it('maps emptyDir storage', async () => {
    const r = await mapStorage([{ name: 'tmp', type: 'emptyDir', mountPath: '/tmp' }]);
    expect(r.volumes).toHaveLength(1);
    expect(r.volumes[0]!.type).toBe('EmptyDirVolume');
  });

  it('maps OSS storage', async () => {
    const r = await mapStorage([{
      name: 'oss-data', type: 'oss', mountPath: '/oss',
      oss: { bucket: 'my-bucket', path: '/data' },
    }]);
    expect(r.volumes).toHaveLength(1);
    expect(r.volumes[0]!.type).toBe('NFSVolume');
    expect(r.volumeMounts).toHaveLength(1);
    expect(r.volumeMounts[0]!.mountPath).toBe('/oss');
  });

  it('skips OSS when oss config is missing', async () => {
    const r = await mapStorage([{ name: 'bad-oss', type: 'oss', mountPath: '/x' } as any]);
    expect(r.volumes).toHaveLength(0);
  });

  it('maps multiple storage entries', async () => {
    const r = await mapStorage([
      { name: 'nfs-vol', type: 'nfs', mountPath: '/nfs', nfs: { server: 's', path: '/p' } },
      { name: 'tmp-vol', type: 'emptyDir', mountPath: '/tmp' },
    ]);
    expect(r.volumes).toHaveLength(2);
    expect(r.volumeMounts).toHaveLength(2);
  });

  it('assigns volumeMounts to first container only', async () => {
    const r = await applyTemplate(minimalTpl({
      container: {
        region: 'local' as any,
        containers: [{ name: 'c1', image: 'i1' }, { name: 'c2', image: 'i2' }],
      },
      extensions: {
        storage: [{ name: 'v', type: 'emptyDir', mountPath: '/d' }],
      },
    }));
    expect(r.containers[0]!.volumeMounts).toHaveLength(1);
    expect(r.containers[1]!.volumeMounts).toBeUndefined();
  });
});

// ─── Extensions ───

describe('applyTemplate extensions', async () => {
  it('maps spotStrategy', async () => {
    const r = await applyTemplate(minimalTpl({ extensions: { spotStrategy: 'SpotAsPriceGo' } }));
    expect(r.spotStrategy).toBe('SpotAsPriceGo');
  });

  it('maps healthMaxRetries', async () => {
    const r = await applyTemplate(minimalTpl({ extensions: { healthMaxRetries: 5 } }));
    expect(r.healthMaxRetries).toBe(5);
  });

  it('maps providerOverrides', async () => {
    const r = await applyTemplate(minimalTpl({ extensions: { providerOverrides: { key: 'val' } } }));
    expect(r.providerOverrides).toEqual({ key: 'val' });
  });
});

// ─── Edge cases ───

describe('applyTemplate edge cases', async () => {
  it('handles template with no container block', async () => {
    const r = await applyTemplate(minimalTpl({ container: undefined as any }));
    expect(r.name).toBe('test-template');
    expect(r.containers).toEqual([]);
    expect(r.resourceSpec.cpu).toBe(0);
    expect(r.resourceSpec.memory).toBe(0);
  });

  it('handles template with empty containers array', async () => {
    const r = await applyTemplate(minimalTpl({
      container: { region: 'local' as any, containers: [] },
    }));
    expect(r.containers).toEqual([]);
    expect(r.resourceSpec.cpu).toBe(0);
    expect(r.resourceSpec.memory).toBe(0);
  });

  it('copies arrays to prevent mutation', async () => {
    const tpl = minimalTpl({
      container: {
        region: 'local' as any,
        containers: [{ name: 'c', image: 'i', command: ['cmd'], args: ['a1', 'a2'], ports: [{ containerPort: 80 }] }],
      },
    });
    const r = await applyTemplate(tpl);
    expect(r.containers[0]!.command).toEqual(['cmd']);
    expect(r.containers[0]!.args).toEqual(['a1', 'a2']);
    expect(r.containers[0]!.ports).toEqual([{ containerPort: 80 }]);
  });

  it('uses container.account when set', async () => {
    const r = await applyTemplate(minimalTpl({
      container: { region: 'local' as any, containers: [{ name: 'c', image: 'i' }], account: 'prod-account' },
    }));
    expect(r.account).toBe('prod-account');
  });

  it('handles health checks targeting non-existent container gracefully', async () => {
    const r = await applyTemplate(minimalTpl({
      container: { region: 'local' as any, containers: [{ name: 'web', image: 'nginx' }] },
      healthChecks: [{
        name: 'orphan', target: 'container:nonexistent', type: 'liveness',
        probe: { httpGet: { path: '/', port: 80 } },
      }],
    }));
    // Should not throw — the probe is just lost
    expect(r.containers).toHaveLength(1);
    expect(r.containers[0]!.livenessProbe).toBeUndefined();
  });
});
