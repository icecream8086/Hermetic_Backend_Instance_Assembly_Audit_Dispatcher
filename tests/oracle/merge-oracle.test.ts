/**
 * Oracle-aligned mergePodSpec tests.
 *
 * References the NRI model (.oracle/tests/nri_pod_merge.py) for the
 * expected merge semantics:
 *   - child's defined fields win, omitted fields inherit from parent
 *   - same-name containers merge at field level
 *   - volumes merge by id, secretMounts by mountPath
 *   - providerOverrides/resolvedSecrets shallow-merge by key
 *
 * Run: npx vitest run tests/oracle/merge-oracle.test.ts
 */

import { describe, it, expect } from 'vitest';
import { mergePodSpec } from '../../src/core/pod/merge.ts';
import type { PodSpec, ContainerSpec } from '../../src/core/pod/types.ts';

function spec(containers: Partial<ContainerSpec>[] = [], overrides = {}): PodSpec {
  return {
    metadata: { name: 'oracle' },
    spec: {
      containers: containers.map(c => ({
        name: c.name ?? 'app',
        image: c.image ?? 'img:latest',
        ...(c.command !== undefined ? { command: c.command } : {}),
        ...(c.args !== undefined ? { args: c.args } : {}),
        ...(c.env !== undefined ? { env: c.env } : {}),
        ...(c.resources !== undefined ? { resources: c.resources } : {}),
        ...(c.ports !== undefined ? { ports: c.ports } : {}),
        ...(c.volumeMounts !== undefined ? { volumeMounts: c.volumeMounts } : {}),
        ...(c.livenessProbe !== undefined ? { livenessProbe: c.livenessProbe } : {}),
        ...(c.readinessProbe !== undefined ? { readinessProbe: c.readinessProbe } : {}),
        ...(c.startupProbe !== undefined ? { startupProbe: c.startupProbe } : {}),
        ...(c.imagePullPolicy !== undefined ? { imagePullPolicy: c.imagePullPolicy } : {}),
        ...(c.tty !== undefined ? { tty: c.tty } : {}),
        ...(c.stdin !== undefined ? { stdin: c.stdin } : {}),
        ...(c.networkMode !== undefined ? { networkMode: c.networkMode } : {}),
        ...(c.providerOverrides !== undefined ? { providerOverrides: c.providerOverrides } : {}),
      })),
      restartPolicy: 'Always',
      ...overrides,
    },
  };
}

describe('mergePodSpec (NRI oracle alignment)', () => {
  it('NRI P1: child scalar overrides parent', () => {
    const p = spec([{ name: 'app', image: 'nginx:1.0' }]);
    const c = spec([{ name: 'app', image: 'nginx:2.0' }]);
    const r = mergePodSpec(p, c);
    expect(r.spec.containers[0].image).toBe('nginx:2.0');
  });

  it('NRI P1: omitted field inherits from parent', () => {
    const p = spec([{ name: 'app', image: 'nginx:1.0', ports: [{ containerPort: 80 }] }]);
    const c = spec([{ name: 'app', image: 'nginx:2.0' }]);
    const r = mergePodSpec(p, c);
    expect(r.spec.containers[0].image).toBe('nginx:2.0');
    expect(r.spec.containers[0].ports).toEqual([{ containerPort: 80 }]);
  });

  it('NRI P2: merge(A, A) = A (idempotent)', () => {
    const a = spec([{ name: 'app', image: 'x:1', ports: [{ containerPort: 80 }], env: [{ name: 'K', value: 'v' }] }]);
    const r = mergePodSpec(a, a);
    expect(r.spec.containers[0].image).toBe('x:1');
    expect(r.spec.containers[0].ports).toEqual([{ containerPort: 80 }]);
    expect(r.spec.containers[0].env).toEqual([{ name: 'K', value: 'v' }]);
  });

  it('NRI P5: same-name containers merge, no duplicates', () => {
    const p = spec([{ name: 'web', image: 'img:1' }, { name: 'sidecar', image: 'side:1' }]);
    const c = spec([{ name: 'web', image: 'img:2' }]);
    const r = mergePodSpec(p, c);
    expect(r.spec.containers).toHaveLength(2);
    expect(r.spec.containers.find(x => x.name === 'web')?.image).toBe('img:2');
    expect(r.spec.containers.find(x => x.name === 'sidecar')?.image).toBe('side:1');
  });

  it('NRI P6: parent-only containers survive', () => {
    const p = spec([{ name: 'common', image: 'c:1' }, { name: 'legacy', image: 'legacy:1' }]);
    const c = spec([{ name: 'common', image: 'c:2' }]);
    const r = mergePodSpec(p, c);
    expect(r.spec.containers.find(x => x.name === 'legacy')?.image).toBe('legacy:1');
  });

  it('NRI P7: child-only containers appear', () => {
    const p = spec([{ name: 'common', image: 'c:1' }]);
    const c = spec([{ name: 'common', image: 'c:2' }, { name: 'new-guy', image: 'new:1' }]);
    const r = mergePodSpec(p, c);
    expect(r.spec.containers.find(x => x.name === 'new-guy')?.image).toBe('new:1');
  });

  it('cross-level inheritance: grandparent ports survive through child', () => {
    const gp = spec([{ name: 'app', image: 'g:1', ports: [{ containerPort: 80 }] }]);
    const p = spec([{ name: 'app', image: 'p:1' }]);
    const c = spec([{ name: 'app', image: 'c:1' }]);
    const r = mergePodSpec(mergePodSpec(gp, p), c);
    expect(r.spec.containers[0].image).toBe('c:1');
    expect(r.spec.containers[0].ports).toEqual([{ containerPort: 80 }]);
  });

  it('diamond nearest ancestor wins (C overrides A ports)', () => {
    const A = spec([{ name: 'app', image: 'a:1', ports: [{ containerPort: 80 }] }]);
    const B = spec([{ name: 'app', image: 'b:1' }]);
    const C = spec([{ name: 'app', image: 'a:1', ports: [{ containerPort: 8080 }] }]);
    const D = spec([{ name: 'app', image: 'b:1' }]);

    // resolveDag order (nearest-first): [C, A, B] after skipping D
    const ab = mergePodSpec(A, B);
    const abc = mergePodSpec(ab, C);
    const abcd = mergePodSpec(abc, D);
    expect(abcd.spec.containers[0].ports![0].containerPort).toBe(8080);
  });

  it('volumes merge by id', () => {
    const p = spec([{ name: 'app', image: 'x:1' }], {
      volumes: [{ id: 'v1', type: 'EmptyDirVolume' as const }],
    });
    const c = spec([{ name: 'app', image: 'x:2' }], {
      volumes: [{ id: 'v2', type: 'NFSVolume' as const }],
    });
    const r = mergePodSpec(p, c);
    expect(r.spec.volumes).toHaveLength(2);
    expect(r.spec.volumes!.find(v => v.id === 'v1')?.type).toBe('EmptyDirVolume');
    expect(r.spec.volumes!.find(v => v.id === 'v2')?.type).toBe('NFSVolume');
  });

  it('initContainers merge by name', () => {
    const p = spec([], {
      initContainers: [{ name: 'init-a', image: 'init:1' }],
    });
    const c = spec([], {
      initContainers: [{ name: 'init-a', image: 'init:2' }, { name: 'init-b', image: 'init:1' }],
    });
    const r = mergePodSpec(p, c);
    expect(r.spec.initContainers).toHaveLength(2);
    expect(r.spec.initContainers![0].image).toBe('init:2');
    expect(r.spec.initContainers![1].name).toBe('init-b');
  });

  it('providerOverrides shallow merge', () => {
    const p = spec([{ name: 'app', image: 'x:1' }], {});
    const pProvider = { ...p, providerOverrides: { alibaba: { region: 'a' }, custom: { key: 'p' } } };
    const cProvider = { ...spec([{ name: 'app', image: 'x:2' }], {}), providerOverrides: { alibaba: { region: 'b' }, extra: { x: 1 } } };
    const r = mergePodSpec(pProvider, cProvider);
    expect(r.providerOverrides?.alibaba).toEqual({ region: 'b' });
    expect(r.providerOverrides?.custom).toEqual({ key: 'p' });
    expect(r.providerOverrides?.extra).toEqual({ x: 1 });
  });

  it('metadata labels child wins entirely', () => {
    const p = { ...spec([]), metadata: { name: 't', labels: { a: '1', b: '2' } } };
    const c = { ...spec([]), metadata: { name: 't', labels: { b: '3', c: '4' } } };
    const r = mergePodSpec(p, c);
    expect(r.metadata.labels).toEqual({ b: '3', c: '4' });
  });
});
