import { describe, it, expect } from 'vitest';
import { mergePodSpec } from '../../../src/core/pod/merge.ts';
import type { PodSpec } from '../../../src/core/pod/types.ts';

describe('mergePodSpec', () => {

  // ─── Container merge by name ───────────────────────────────────────────

  it('merges containers by name, child replacing same-name container', () => {
    const parent: PodSpec = {
      metadata: { name: 'test' },
      spec: {
        containers: [
          { name: 'web', image: 'nginx:latest' },
          { name: 'worker', image: 'worker:latest' },
        ],
        restartPolicy: 'Always',
      },
    };
    const child: PodSpec = {
      metadata: { name: 'test' },
      spec: {
        containers: [
          { name: 'web', image: 'nginx:alpine' },
          { name: 'sidecar', image: 'sidecar:latest' },
        ],
        restartPolicy: 'Always',
      },
    };

    const result = mergePodSpec(parent, child);

    expect(result.spec.containers).toHaveLength(3);
    expect(result.spec.containers.find(c => c.name === 'web')?.image).toBe('nginx:alpine');
    expect(result.spec.containers.find(c => c.name === 'worker')?.image).toBe('worker:latest');
    expect(result.spec.containers.find(c => c.name === 'sidecar')?.image).toBe('sidecar:latest');
  });

  // ─── Volume merge by id ────────────────────────────────────────────────

  it('merges volumes by id, child replacing same-id volume', () => {
    const parent: PodSpec = {
      metadata: { name: 'test' },
      spec: {
        containers: [{ name: 'web', image: 'nginx' }],
        restartPolicy: 'Always',
        volumes: [
          { id: 'vol-1', type: 'NFSVolume' },
          { id: 'vol-2', type: 'DiskVolume' },
        ],
      },
    };
    const child: PodSpec = {
      metadata: { name: 'test' },
      spec: {
        containers: [{ name: 'web', image: 'nginx' }],
        restartPolicy: 'Always',
        volumes: [
          { id: 'vol-2', type: 'OSSVolume' },
          { id: 'vol-3', type: 'EmptyDirVolume' },
        ],
      },
    };

    const result = mergePodSpec(parent, child);

    expect(result.spec.volumes).toHaveLength(3);
    expect(result.spec.volumes?.find(v => v.id === 'vol-1')?.type).toBe('NFSVolume');
    expect(result.spec.volumes?.find(v => v.id === 'vol-2')?.type).toBe('OSSVolume');
    expect(result.spec.volumes?.find(v => v.id === 'vol-3')?.type).toBe('EmptyDirVolume');
  });

  // ─── initContainers merge by name ──────────────────────────────────────

  it('merges initContainers by name', () => {
    const parent: PodSpec = {
      metadata: { name: 'test' },
      spec: {
        containers: [{ name: 'web', image: 'nginx' }],
        restartPolicy: 'Always',
        initContainers: [
          { name: 'setup', image: 'busybox:1.0' },
          { name: 'check', image: 'alpine:1.0' },
        ],
      },
    };
    const child: PodSpec = {
      metadata: { name: 'test' },
      spec: {
        containers: [{ name: 'web', image: 'nginx' }],
        restartPolicy: 'Always',
        initContainers: [
          { name: 'setup', image: 'busybox:2.0' },
          { name: 'migrate', image: 'migrate:latest' },
        ],
      },
    };

    const result = mergePodSpec(parent, child);

    expect(result.spec.initContainers).toHaveLength(3);
    expect(result.spec.initContainers?.find(c => c.name === 'setup')?.image).toBe('busybox:2.0');
    expect(result.spec.initContainers?.find(c => c.name === 'check')?.image).toBe('alpine:1.0');
    expect(result.spec.initContainers?.find(c => c.name === 'migrate')?.image).toBe('migrate:latest');
  });

  // ─── providerOverrides shallow merge ───────────────────────────────────

  it('shallow merges providerOverrides by top-level key', () => {
    const parent: PodSpec = {
      metadata: { name: 'test' },
      spec: {
        containers: [{ name: 'web', image: 'nginx' }],
        restartPolicy: 'Always',
      },
      providerOverrides: {
        alibaba: { region: 'cn-hangzhou' },
      },
    };
    const child: PodSpec = {
      metadata: { name: 'test' },
      spec: {
        containers: [{ name: 'web', image: 'nginx' }],
        restartPolicy: 'Always',
      },
      providerOverrides: {
        alibaba: { spotStrategy: 'SpotAsPriceGo' },
        aws: { region: 'us-east-1' },
      },
    };

    const result = mergePodSpec(parent, child);

    expect(result.providerOverrides).toEqual({
      alibaba: { spotStrategy: 'SpotAsPriceGo' },
      aws: { region: 'us-east-1' },
    });
  });

  // ─── Child scalar overrides parent ─────────────────────────────────────

  it('child scalar overrides parent when both set', () => {
    const parent: PodSpec = {
      metadata: { name: 'test' },
      spec: {
        containers: [{ name: 'web', image: 'nginx' }],
        restartPolicy: 'Always',
        priority: 5,
        terminationGracePeriodSeconds: 30,
      },
    };
    const child: PodSpec = {
      metadata: { name: 'test' },
      spec: {
        containers: [{ name: 'web', image: 'nginx' }],
        restartPolicy: 'Never',
        priority: 10,
        terminationGracePeriodSeconds: 60,
      },
    };

    const result = mergePodSpec(parent, child);

    expect(result.spec.restartPolicy).toBe('Never');
    expect(result.spec.priority).toBe(10);
    expect(result.spec.terminationGracePeriodSeconds).toBe(60);
  });

  // ─── Parent scalar preserved ───────────────────────────────────────────

  it('preserves parent scalar when child does not set it', () => {
    const parent: PodSpec = {
      metadata: { name: 'test', labels: { app: 'myapp' } },
      spec: {
        containers: [{ name: 'web', image: 'nginx' }],
        restartPolicy: 'Always',
        priority: 5,
        terminationGracePeriodSeconds: 30,
      },
    };
    const child: PodSpec = {
      metadata: { name: 'test' },
      spec: {
        containers: [{ name: 'web', image: 'nginx' }],
        restartPolicy: 'Always',
      },
    };

    const result = mergePodSpec(parent, child);

    expect(result.spec.priority).toBe(5);
    expect(result.spec.terminationGracePeriodSeconds).toBe(30);
    expect(result.metadata.labels).toEqual({ app: 'myapp' });
  });

  // ─── Empty child returns parent ────────────────────────────────────────

  it('returns parent when child provides no meaningful overrides', () => {
    const parent: PodSpec = {
      metadata: {
        name: 'test',
        labels: { app: 'test', tier: 'web' },
        annotations: { note: 'original' },
      },
      spec: {
        containers: [{ name: 'web', image: 'nginx' }],
        restartPolicy: 'Always',
        priority: 5,
        nodeSelector: { disk: 'ssd' },
        terminationGracePeriodSeconds: 30,
        volumes: [{ id: 'vol-1', type: 'NFSVolume' }],
      },
    };
    const child: PodSpec = {
      metadata: { name: 'test' },
      spec: {
        containers: [{ name: 'web', image: 'nginx' }],
        restartPolicy: 'Always',
      },
    };

    const result = mergePodSpec(parent, child);

    expect(result).toEqual(parent);
  });

  // ─── Full override ─────────────────────────────────────────────────────

  it('child wins for scalars, merges keyed arrays, shallow merges maps', () => {
    const parent: PodSpec = {
      metadata: { name: 'parent', labels: { env: 'prod' }, annotations: { team: 'alpha' } },
      spec: {
        containers: [
          { name: 'web', image: 'nginx:1.0' },
          { name: 'worker', image: 'worker:1.0' },
        ],
        initContainers: [
          { name: 'setup', image: 'busybox:1.0' },
        ],
        volumes: [
          { id: 'vol-1', type: 'NFSVolume' },
        ],
        restartPolicy: 'OnFailure',
        priority: 1,
        nodeSelector: { zone: 'a' },
        terminationGracePeriodSeconds: 10,
        dnsConfig: { nameservers: ['8.8.8.8'] },
        hostAliases: [{ ip: '127.0.0.1', hostnames: ['local'] }],
        secretRefs: [{ secretName: 's1', mountPath: '/s1' }],
        resolvedSecrets: { s1: { value: 'old' } },
        secretMounts: [{ mountPath: '/secret', data: 'old-data' }],
        topologySpreadConstraints: [
          { maxSkew: 1, topologyKey: 'zone', whenUnsatisfiable: 'ScheduleAnyway' },
        ],
        affinity: {
          nodeAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: {
              nodeSelectorTerms: [
                { matchExpressions: [{ key: 'type', operator: 'In', values: ['compute'] }] },
              ],
            },
          },
        },
        tolerations: [{ key: 'spot', operator: 'Exists' }],
        preemptionPolicy: 'Never',
      },
      providerOverrides: {
        alibaba: { region: 'cn-hangzhou' },
      },
    };

    const child: PodSpec = {
      metadata: { name: 'child', labels: { env: 'staging' }, annotations: { team: 'beta' } },
      spec: {
        containers: [
          { name: 'web', image: 'nginx:2.0' },
          { name: 'sidecar', image: 'sidecar:2.0' },
        ],
        initContainers: [
          { name: 'setup', image: 'busybox:2.0' },
          { name: 'init-db', image: 'db:2.0' },
        ],
        volumes: [
          { id: 'vol-1', type: 'OSSVolume' },
          { id: 'vol-4', type: 'EmptyDirVolume' },
        ],
        restartPolicy: 'Never',
        priority: 10,
        nodeSelector: { zone: 'b' },
        terminationGracePeriodSeconds: 60,
        dnsConfig: { nameservers: ['1.1.1.1'] },
        hostAliases: [{ ip: '10.0.0.1', hostnames: ['remote'] }],
        secretRefs: [{ secretName: 's2', mountPath: '/s2' }],
        resolvedSecrets: { s1: { value: 'new' }, s2: { value: 'new2' } },
        secretMounts: [{ mountPath: '/secret', data: 'new-data' }],
        topologySpreadConstraints: [
          { maxSkew: 2, topologyKey: 'host', whenUnsatisfiable: 'DoNotSchedule' },
        ],
        affinity: {
          nodeAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: {
              nodeSelectorTerms: [
                { matchExpressions: [{ key: 'size', operator: 'In', values: ['large'] }] },
              ],
            },
          },
        },
        tolerations: [{ key: 'gpu', operator: 'Exists' }],
        preemptionPolicy: 'PreemptLowerPriority',
      },
      providerOverrides: {
        alibaba: { spotStrategy: 'SpotAsPriceGo' },
        aws: { region: 'us-east-1' },
      },
    };

    const result = mergePodSpec(parent, child);

    // ── metadata — child overwrites entirely ──
    expect(result.metadata.name).toBe('child');
    expect(result.metadata.labels).toEqual({ env: 'staging' });
    expect(result.metadata.annotations).toEqual({ team: 'beta' });

    // ── containers — merged by name ──
    expect(result.spec.containers).toHaveLength(3);
    expect(result.spec.containers.find(c => c.name === 'web')?.image).toBe('nginx:2.0');
    expect(result.spec.containers.find(c => c.name === 'worker')?.image).toBe('worker:1.0');
    expect(result.spec.containers.find(c => c.name === 'sidecar')?.image).toBe('sidecar:2.0');

    // ── initContainers — merged by name ──
    expect(result.spec.initContainers).toHaveLength(2);
    expect(result.spec.initContainers?.find(c => c.name === 'setup')?.image).toBe('busybox:2.0');
    expect(result.spec.initContainers?.find(c => c.name === 'init-db')?.image).toBe('db:2.0');

    // ── volumes — merged by id ──
    // Parent: vol-1; Child: vol-1 (override) + vol-4 → 2 total
    expect(result.spec.volumes).toHaveLength(2);
    expect(result.spec.volumes?.find(v => v.id === 'vol-1')?.type).toBe('OSSVolume');
    expect(result.spec.volumes?.find(v => v.id === 'vol-4')?.type).toBe('EmptyDirVolume');

    // ── scalar overrides ──
    expect(result.spec.restartPolicy).toBe('Never');
    expect(result.spec.priority).toBe(10);
    expect(result.spec.nodeSelector).toEqual({ zone: 'b' });
    expect(result.spec.terminationGracePeriodSeconds).toBe(60);
    expect(result.spec.dnsConfig).toEqual({ nameservers: ['1.1.1.1'] });
    expect(result.spec.hostAliases).toEqual([{ ip: '10.0.0.1', hostnames: ['remote'] }]);
    expect(result.spec.preemptionPolicy).toBe('PreemptLowerPriority');

    // ── secretRefs — child overrides parent ──
    expect(result.spec.secretRefs).toHaveLength(1);
    expect(result.spec.secretRefs?.[0].secretName).toBe('s2');

    // ── resolvedSecrets — shallow merge ──
    expect(result.spec.resolvedSecrets).toEqual({
      s1: { value: 'new' },
      s2: { value: 'new2' },
    });

    // ── secretMounts — merged by mountPath ──
    expect(result.spec.secretMounts).toHaveLength(1);
    expect(result.spec.secretMounts?.[0].data).toBe('new-data');

    // ── array fields — child replaces parent ──
    expect(result.spec.topologySpreadConstraints).toHaveLength(1);
    expect(result.spec.topologySpreadConstraints?.[0].maxSkew).toBe(2);
    expect(result.spec.tolerations).toHaveLength(1);
    expect(result.spec.tolerations?.[0].key).toBe('gpu');

    // ── providerOverrides — shallow merge ──
    expect(result.providerOverrides).toEqual({
      alibaba: { spotStrategy: 'SpotAsPriceGo' },
      aws: { region: 'us-east-1' },
    });
  });

  // ─── Edge: Child sets volumes to empty array ───────────────────────────

  it('handles child with empty volumes array', () => {
    const parent: PodSpec = {
      metadata: { name: 'test' },
      spec: {
        containers: [{ name: 'web', image: 'nginx' }],
        restartPolicy: 'Always',
        volumes: [
          { id: 'vol-1', type: 'NFSVolume' },
        ],
      },
    };
    const child: PodSpec = {
      metadata: { name: 'test' },
      spec: {
        containers: [{ name: 'web', image: 'nginx' }],
        restartPolicy: 'Always',
        volumes: [],
      },
    };

    const result = mergePodSpec(parent, child);

    // Empty child array merges with parent — result still has parent volumes
    expect(result.spec.volumes).toHaveLength(1);
    expect(result.spec.volumes?.[0].id).toBe('vol-1');
  });

  // ─── Edge: Child with undefined array fields inherits from parent ──────

  it('inherits array fields from parent when child does not set them', () => {
    const parent: PodSpec = {
      metadata: { name: 'test' },
      spec: {
        containers: [{ name: 'web', image: 'nginx' }],
        restartPolicy: 'Always',
        volumes: [{ id: 'shared', type: 'NFSVolume' }],
        secretRefs: [{ secretName: 'db-cred', mountPath: '/db' }],
        tolerations: [{ key: 'spot', operator: 'Exists' }],
      },
    };
    const child: PodSpec = {
      metadata: { name: 'test' },
      spec: {
        containers: [{ name: 'web', image: 'nginx' }],
        restartPolicy: 'Always',
      },
    };

    const result = mergePodSpec(parent, child);

    expect(result.spec.volumes).toEqual(parent.spec.volumes);
    expect(result.spec.secretRefs).toEqual(parent.spec.secretRefs);
    expect(result.spec.tolerations).toEqual(parent.spec.tolerations);
  });

  // ─── Edge: providerOverrides absent in child ──────────────────────────

  it('preserves parent providerOverrides when child does not set them', () => {
    const parent: PodSpec = {
      metadata: { name: 'test' },
      spec: {
        containers: [{ name: 'web', image: 'nginx' }],
        restartPolicy: 'Always',
      },
      providerOverrides: {
        alibaba: { region: 'cn-hangzhou' },
      },
    };
    const child: PodSpec = {
      metadata: { name: 'test' },
      spec: {
        containers: [{ name: 'web', image: 'nginx' }],
        restartPolicy: 'Always',
      },
    };

    const result = mergePodSpec(parent, child);

    expect(result.providerOverrides).toEqual({ alibaba: { region: 'cn-hangzhou' } });
  });
});
