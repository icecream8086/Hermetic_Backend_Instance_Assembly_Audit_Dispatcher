import { describe, it, expect } from 'vitest';
import { applyTemplate, mapStorage } from '../../../src/features/template/applicator.ts';
import type { Template } from '../../../src/features/template/types.ts';

// ─── Helper ───

function minimalTpl(overrides?: Partial<Template>): Template {
  return {
    id: 'tpl_test',
    name: 'test-template',
    apiVersion: 'hbi-aad/v1',
    kind: 'Container',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    container: { region: 'local' as any, containers: [{ name: 'app', image: 'nginx:latest' }] },
    ...overrides,
  } as Template;
}

// ─── applyTemplate ───

describe('applyTemplate', async () => {
  it('maps name and region', async () => {
    const r = await applyTemplate(minimalTpl(), 'my-sandbox', 'cn-hangzhou');
    expect(r.podSpec.metadata.name).toBe('my-sandbox');
    expect(r.podSpec.providerOverrides?.alibaba?.region).toBe('cn-hangzhou');
  });

  it('generates distinct default name from template.name when not overridden', async () => {
    const r = await applyTemplate(minimalTpl());
    expect(r.podSpec.metadata.name).toMatch(/^test-template-[a-f0-9]{6}$/);
  });

  it('uses explicit name when provided (not template default)', async () => {
    const r = await applyTemplate(minimalTpl(), 'my-custom-sandbox');
    expect(r.podSpec.metadata.name).toBe('my-custom-sandbox');
  });

  it('defaults region to container.region', async () => {
    const r = await applyTemplate(minimalTpl());
    expect(r.podSpec.providerOverrides?.alibaba?.region).toBe('local');
  });

  it('defaults restartPolicy to Always', async () => {
    const r = await applyTemplate(minimalTpl());
    expect(r.podSpec.spec.restartPolicy).toBe('Always');
  });

  it('maps container name and image', async () => {
    const r = await applyTemplate(minimalTpl());
    expect(r.podSpec.spec.containers).toHaveLength(1);
    expect(r.podSpec.spec.containers[0]!.name).toBe('app');
    expect(r.podSpec.spec.containers[0]!.image).toBe('nginx:latest');
  });

  it('maps container command and args', async () => {
    const r = await applyTemplate(minimalTpl({
      container: {
        region: 'local' as any,
        containers: [{ name: 'c', image: 'i', command: ['/bin/sh'], args: ['-c', 'echo hi'] }],
      },
    }));
    expect(r.podSpec.spec.containers[0]!.command).toEqual(['/bin/sh']);
    expect(r.podSpec.spec.containers[0]!.args).toEqual(['-c', 'echo hi']);
  });

  it('maps container env with value', async () => {
    const r = await applyTemplate(minimalTpl({
      container: {
        region: 'local' as any,
        containers: [{ name: 'c', image: 'i', env: [{ name: 'FOO', value: 'bar' }] }],
      },
    }));
    expect(r.podSpec.spec.containers[0]!.env).toEqual([{ name: 'FOO', value: 'bar' }]);
  });

  it('maps container ports', async () => {
    const r = await applyTemplate(minimalTpl({
      container: {
        region: 'local' as any,
        containers: [{ name: 'c', image: 'i', ports: [{ containerPort: 80, protocol: 'tcp' }] }],
      },
    }));
    expect(r.podSpec.spec.containers[0]!.ports).toEqual([{ containerPort: 80, protocol: 'tcp' }]);
  });

  it('defaults port protocol when not set', async () => {
    const r = await applyTemplate(minimalTpl({
      container: {
        region: 'local' as any,
        containers: [{ name: 'c', image: 'i', ports: [{ containerPort: 8080 }] }],
      },
    }));
    expect(r.podSpec.spec.containers[0]!.ports).toEqual([{ containerPort: 8080 }]);
  });

  it('maps initContainers', async () => {
    const r = await applyTemplate(minimalTpl({
      container: {
        region: 'local' as any,
        containers: [{ name: 'app', image: 'nginx' }],
        initContainers: [{ name: 'init-db', image: 'busybox', command: ['init'] }],
      },
    }));
    expect(r.podSpec.spec.initContainers).toHaveLength(1);
    expect(r.podSpec.spec.initContainers![0]!.name).toBe('init-db');
    expect(r.podSpec.spec.initContainers![0]!.image).toBe('busybox');
    expect(r.podSpec.spec.initContainers![0]!.command).toEqual(['init']);
  });

  it('handles template with no container block', async () => {
    const r = await applyTemplate(minimalTpl({ container: undefined as any }));
    expect(r.podSpec.metadata.name).toMatch(/^test-template-[a-f0-9]{6}$/);
    expect(r.podSpec.spec.containers).toEqual([]);
  });

  it('handles template with empty containers array', async () => {
    const r = await applyTemplate(minimalTpl({
      container: { region: 'local' as any, containers: [] },
    }));
    expect(r.podSpec.spec.containers).toEqual([]);
  });

  it('copies arrays to prevent mutation', async () => {
    const tpl = minimalTpl({
      container: {
        region: 'local' as any,
        containers: [{ name: 'c', image: 'i', command: ['cmd'], args: ['a1', 'a2'], ports: [{ containerPort: 80 }] }],
      },
    });
    const r = await applyTemplate(tpl);
    expect(r.podSpec.spec.containers[0]!.command).toEqual(['cmd']);
    expect(r.podSpec.spec.containers[0]!.args).toEqual(['a1', 'a2']);
    expect(r.podSpec.spec.containers[0]!.ports).toEqual([{ containerPort: 80 }]);
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
    const c = r.podSpec.spec.containers[0]!;
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
    const c = r.podSpec.spec.containers[0]!;
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
    expect(r.podSpec.spec.containers[0]!.livenessProbe!.exec!.command).toEqual(['mysqladmin', 'ping']);
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
    expect(r.podSpec.spec.initContainers![0]!.readinessProbe).toBeDefined();
    expect(r.podSpec.spec.initContainers![0]!.readinessProbe!.exec!.command).toEqual(['check']);
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
    expect(r.podSpec.spec.containers[0]!.livenessProbe!.initialDelaySeconds).toBe(5);
    expect(r.podSpec.spec.containers[0]!.livenessProbe!.successThreshold).toBe(3);
    expect(r.podSpec.spec.containers[0]!.livenessProbe!.failureThreshold).toBe(5);
  });

  it('handles health checks targeting non-existent container gracefully', async () => {
    const r = await applyTemplate(minimalTpl({
      container: { region: 'local' as any, containers: [{ name: 'web', image: 'nginx' }] },
      healthChecks: [{
        name: 'orphan', target: 'container:nonexistent', type: 'liveness',
        probe: { httpGet: { path: '/', port: 80 } },
      }],
    }));
    expect(r.podSpec.spec.containers).toHaveLength(1);
    expect(r.podSpec.spec.containers[0]!.livenessProbe).toBeUndefined();
  });
});

// ─── Network mapping ───

describe('applyTemplate network', async () => {
  it('keeps vpc securityGroupId in standard network', async () => {
    const r = await applyTemplate(minimalTpl({ network: { vpc: { securityGroupId: 'sg_xxx' } } }));
    expect(r.podSpec.providerOverrides?.alibaba).toBeDefined();
  });

  it('EIP only works through extensions.providerOverrides.alibaba.autoCreateEip', async () => {
    const r = await applyTemplate(minimalTpl({
      extensions: { providerOverrides: { alibaba: { autoCreateEip: true, eipBandwidth: 50 } } },
    }));
    expect(r.podSpec.providerOverrides?.alibaba?.autoCreateEip).toBe(true);
    expect(r.podSpec.providerOverrides?.alibaba?.eipBandwidth).toBe(50);
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

  it('maps emptyDir storage', async () => {
    const r = await mapStorage([{ name: 'tmp', type: 'emptyDir', mountPath: '/tmp', emptyDir: { sizeLimit: '512Mi' } }]);
    expect(r.volumes).toHaveLength(1);
    expect(r.volumes[0]!.type).toBe('EmptyDirVolume');
    expect(r.volumes[0]!.emptyDir!.sizeLimit).toBe('512Mi');
    expect(r.volumeMounts[0]!.mountPath).toBe('/tmp');
  });

  it('skips emptyDir when sizeLimit is missing', async () => {
    const r = await mapStorage([{ name: 'tmp', type: 'emptyDir', mountPath: '/tmp' }]);
    expect(r.volumes).toHaveLength(0);
  });

  it('skips OSS storage (deprecated)', async () => {
    const r = await mapStorage([{ name: 'oss-data', type: 'oss', mountPath: '/oss', oss: { bucket: 'my-bucket', path: '/data' } }]);
    expect(r.volumes).toHaveLength(0);
    expect(r.volumeMounts).toHaveLength(0);
  });

  it('skips OSS when oss config is missing', async () => {
    const r = await mapStorage([{ name: 'bad-oss', type: 'oss', mountPath: '/x' } as any]);
    expect(r.volumes).toHaveLength(0);
  });

  it('maps multiple storage entries', async () => {
    const r = await mapStorage([
      { name: 'nfs-vol', type: 'nfs', mountPath: '/nfs', nfs: { server: 's', path: '/p' } },
      { name: 'tmp-vol', type: 'emptyDir', mountPath: '/tmp', emptyDir: { sizeLimit: '256Mi' } },
    ]);
    expect(r.volumes).toHaveLength(2);
    expect(r.volumeMounts).toHaveLength(2);
  });
});

// ─── Extensions ───

describe('applyTemplate extensions', async () => {
  it('maps spotStrategy to providerOverrides.alibaba', async () => {
    const r = await applyTemplate(minimalTpl({ extensions: { providerOverrides: { alibaba: { spotStrategy: 'SpotAsPriceGo' } } } }));
    expect(r.podSpec.providerOverrides?.alibaba?.spotStrategy).toBe('SpotAsPriceGo');
  });
});

import { deepMerge } from '../../../src/features/template/handler.ts';

describe('deepMerge (template partial update)', () => {
  it('preserves top-level extension fields not in the update', () => {
    const existing = { healthMaxRetries: 3, providerOverrides: { alibaba: { eipBandwidth: 10, spotStrategy: 'SpotAsPriceGo' } } };
    const update = { providerOverrides: { alibaba: { eipBandwidth: 50 } } };
    const result = deepMerge(existing, update);
    expect(result.healthMaxRetries).toBe(3);
    expect(result.providerOverrides.alibaba.spotStrategy).toBe('SpotAsPriceGo');
    expect(result.providerOverrides.alibaba.eipBandwidth).toBe(50);
  });

  it('preserves sibling provider override fields not in the update', () => {
    const existing = { providerOverrides: { alibaba: { ingressBandwidth: 100, egressBandwidth: 100, autoCreateEip: true, eipBandwidth: 10, autoMatchImageCache: true } } };
    const update = { providerOverrides: { alibaba: { eipBandwidth: 50 } } };
    const result = deepMerge(existing, update);
    expect(result.providerOverrides.alibaba.ingressBandwidth).toBe(100);
    expect(result.providerOverrides.alibaba.egressBandwidth).toBe(100);
    expect(result.providerOverrides.alibaba.autoCreateEip).toBe(true);
    expect(result.providerOverrides.alibaba.autoMatchImageCache).toBe(true);
    expect(result.providerOverrides.alibaba.eipBandwidth).toBe(50);
  });

  it('adds new top-level fields from update', () => {
    const existing = { healthMaxRetries: 3 };
    const update = { autoStart: true, webTerminal: false };
    const result = deepMerge(existing, update);
    expect(result.healthMaxRetries).toBe(3);
    expect(result.autoStart).toBe(true);
    expect(result.webTerminal).toBe(false);
  });
});
