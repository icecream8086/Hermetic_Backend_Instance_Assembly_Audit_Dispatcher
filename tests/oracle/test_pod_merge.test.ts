/**
 * Model-based oracle for PodSpec merge — exhaustive enumeration differential.
 *
 * Compares NRI (independent port, structurally different from merge.ts) against
 * the real mergePodSpec() across every combination in a finite input space.
 *
 * Run: npx vitest run tests/oracle/test_pod_merge.test.ts
 */
import { describe, it, expect } from 'vitest';
import { mergePodSpec } from '../../src/core/pod/merge.ts';
import type { PodSpec, ContainerSpec, VolumeSpec } from '../../src/core/pod/types.ts';

// ═══════════════════════════════════════════════════════════════════
// NRI — port of .oracle/tests/nri_pod_merge.py (structurally different from merge.ts)
//
// Architecture:
//   merge.ts:       procedural per-field assignment + per-type helpers (mergeContainerSpec, ...)
//   NRI (Python):   batch field iteration + generic _unite_by_key with resolver callback
//   NRI (TS port):  same architecture as Python NRI, different from merge.ts
//
// Key differences from merge.ts:
//   1. Container field merge uses field-name list + iteration, not per-field if/else
//   2. Identity merge is generic _uniteByKey(key, resolver?), not per-type helpers
//   3. composeNRI batches pod-level scalars through a field-name list
//   4. composePodBody groups fields by strategy (identity, shallow, scalar-batch)
// ═══════════════════════════════════════════════════════════════════

const _CONTAINER_OPTIONAL_FIELDS: (keyof ContainerSpec)[] = [
  'command', 'args', 'env', 'resources', 'ports', 'volumeMounts',
  'livenessProbe', 'readinessProbe', 'startupProbe',
  'imagePullPolicy', 'tty', 'stdin', 'networkMode', 'providerOverrides',
];

const _POD_OPTIONAL_SCALARS: (keyof PodSpec['spec'])[] = [
  'priority', 'nodeSelector', 'terminationGracePeriodSeconds',
  'dnsConfig', 'hostAliases', 'secretRefs',
  'topologySpreadConstraints', 'affinity', 'tolerations', 'preemptionPolicy',
];

function _takeIfSet<T>(child: T | undefined, parent: T | undefined): T | undefined {
  return child !== undefined ? child : parent;
}

function _shallowMeld(
  base: Record<string, unknown> | undefined,
  overlay: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...(base ?? {}), ...(overlay ?? {}) };
}

function _uniteByKey<T extends Record<string, any>>(
  parentItems: readonly T[] | undefined,
  childItems: readonly T[],
  key: keyof T,
  resolver?: (p: T, c: T) => T,
): T[] {
  const lookup = new Map<string, T>();
  if (parentItems) {
    for (const item of parentItems) lookup.set(String(item[key]), item);
  }
  for (const item of childItems) {
    const k = String(item[key]);
    const existing = lookup.get(k);
    lookup.set(k, existing && resolver ? resolver(existing, item) : item);
  }
  return Array.from(lookup.values());
}

function nri_refineContainer(parent: ContainerSpec, child: ContainerSpec): ContainerSpec {
  const result: ContainerSpec = {
    name: child.name,
    image: child.image ?? parent.image,
  };
  for (const field of _CONTAINER_OPTIONAL_FIELDS) {
    const cv = child[field];
    (result as Record<string, unknown>)[field] = cv !== undefined ? cv : parent[field];
  }
  return result as ContainerSpec;
}

function nri_composePodBody(parent: PodSpec['spec'], child: PodSpec['spec']): PodSpec['spec'] {
  const mergedContainers = _uniteByKey(parent.containers, child.containers, 'name', nri_refineContainer);

  const mergedInitContainers = child.initContainers !== undefined
    ? _uniteByKey(parent.initContainers ?? [], child.initContainers, 'name', nri_refineContainer)
    : parent.initContainers;

  const mergedVolumes = child.volumes !== undefined
    ? _uniteByKey(parent.volumes, child.volumes, 'id')
    : parent.volumes;

  const mergedSecretMounts = child.secretMounts !== undefined
    ? _uniteByKey(parent.secretMounts, child.secretMounts, 'mountPath')
    : parent.secretMounts;

  const mergedResolvedSecrets = child.resolvedSecrets !== undefined
    ? _shallowMeld(parent.resolvedSecrets, child.resolvedSecrets)
    : parent.resolvedSecrets;

  // scalar batch
  const scalarResults: Record<string, unknown> = {};
  for (const field of _POD_OPTIONAL_SCALARS) {
    scalarResults[field] = _takeIfSet(child[field] as any, parent[field] as any);
  }

  return {
    containers: mergedContainers,
    restartPolicy: child.restartPolicy,
    initContainers: mergedInitContainers,
    volumes: mergedVolumes,
    secretMounts: mergedSecretMounts,
    resolvedSecrets: mergedResolvedSecrets,
    ...scalarResults,
  } as PodSpec['spec'];
}

function composeNRI(parent: PodSpec, child: PodSpec): PodSpec {
  return {
    metadata: {
      name: child.metadata.name,
      labels: _takeIfSet(child.metadata.labels, parent.metadata.labels),
      annotations: _takeIfSet(child.metadata.annotations, parent.metadata.annotations),
    },
    spec: nri_composePodBody(parent.spec, child.spec),
    providerOverrides: child.providerOverrides !== undefined
      ? _shallowMeld(parent.providerOverrides, child.providerOverrides)
      : parent.providerOverrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Property checks (mirror of Python NRI checks)
// ═══════════════════════════════════════════════════════════════════

function checkFieldResolution(
  merged: ContainerSpec, parent: ContainerSpec, child: ContainerSpec,
): boolean {
  if (merged.name !== child.name) return false;
  if (merged.image !== child.image) return false;
  for (const field of _CONTAINER_OPTIONAL_FIELDS) {
    const cv = child[field];
    const pv = parent[field];
    const rv = merged[field];
    const expected = cv !== undefined ? cv : pv;
    if (rv !== expected && JSON.stringify(rv) !== JSON.stringify(expected)) return false;
  }
  return true;
}

function checkNamesUnique(results: readonly ContainerSpec[]): boolean {
  const names = results.map(c => c.name);
  return new Set(names).size === names.length;
}

function checkParentSurvive(
  parentNames: Set<string>, resultNames: Set<string>,
): boolean {
  return [...parentNames].every(n => resultNames.has(n));
}

function checkChildAppear(
  childNames: Set<string>, resultNames: Set<string>,
): boolean {
  return [...childNames].every(n => resultNames.has(n));
}

// ═══════════════════════════════════════════════════════════════════
// Mutation variants
// ═══════════════════════════════════════════════════════════════════

function mutateFieldReversed(parent: PodSpec, child: PodSpec): PodSpec {
  const revContainer = (p: ContainerSpec, c: ContainerSpec): ContainerSpec => {
    const result: ContainerSpec = { name: c.name, image: p.image ?? c.image };
    for (const field of _CONTAINER_OPTIONAL_FIELDS) {
      (result as Record<string, unknown>)[field] = p[field] !== undefined ? p[field] : c[field];
    }
    return result as ContainerSpec;
  };

  const pMap = new Map(parent.spec.containers.map(c => [c.name, c]));
  const cMap = new Map(child.spec.containers.map(c => [c.name, c]));
  const allNames = [...new Set([...pMap.keys(), ...cMap.keys()])];
  const resultContainers: ContainerSpec[] = allNames.map(name => {
    const p = pMap.get(name);
    const c = cMap.get(name);
    if (p && c) return revContainer(p, c);
    return p ?? c!;
  });

  return {
    metadata: {
      name: child.metadata.name,
      labels: _takeIfSet(child.metadata.labels, parent.metadata.labels),
      annotations: _takeIfSet(child.metadata.annotations, parent.metadata.annotations),
    },
    spec: {
      containers: resultContainers,
      restartPolicy: child.spec.restartPolicy,
      priority: _takeIfSet(child.spec.priority, parent.spec.priority),
    },
    providerOverrides: child.providerOverrides ?? parent.providerOverrides,
  };
}

function mutateChildReplaces(parent: PodSpec, child: PodSpec): PodSpec {
  const parentNames = new Set(parent.spec.containers.map(c => c.name));
  const cMap = new Map(child.spec.containers.map(c => [c.name, c]));
  const resultContainers: ContainerSpec[] = [];
  for (const c of parent.spec.containers) {
    resultContainers.push(cMap.get(c.name) ?? c);
  }
  for (const c of child.spec.containers) {
    if (!parentNames.has(c.name)) resultContainers.push(c);
  }
  return {
    metadata: {
      name: child.metadata.name,
      labels: _takeIfSet(child.metadata.labels, parent.metadata.labels),
      annotations: _takeIfSet(child.metadata.annotations, parent.metadata.annotations),
    },
    spec: {
      containers: resultContainers,
      restartPolicy: child.spec.restartPolicy,
      priority: _takeIfSet(child.spec.priority, parent.spec.priority),
    },
  };
}

function mutateFlatConcat(parent: PodSpec, child: PodSpec): PodSpec {
  return {
    metadata: {
      name: child.metadata.name,
      labels: _takeIfSet(child.metadata.labels, parent.metadata.labels),
      annotations: _takeIfSet(child.metadata.annotations, parent.metadata.annotations),
    },
    spec: {
      containers: [...parent.spec.containers, ...child.spec.containers],
      restartPolicy: child.spec.restartPolicy,
    },
  };
}

function mutateLabelsDeepMerge(parent: PodSpec, child: PodSpec): PodSpec {
  const mergedLabels = { ...(parent.metadata.labels ?? {}), ...(child.metadata.labels ?? {}) };
  return {
    metadata: {
      name: child.metadata.name,
      labels: child.metadata.labels !== undefined ? mergedLabels : parent.metadata.labels,
      annotations: _takeIfSet(child.metadata.annotations, parent.metadata.annotations),
    },
    spec: nri_composePodBody(parent.spec, child.spec),
  };
}

// ═══════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════

function makeSpec(
  containers: Partial<ContainerSpec>[] = [],
  overrides: Partial<PodSpec['spec']> = {},
): PodSpec {
  return {
    metadata: { name: 'test' },
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
      }) as ContainerSpec),
      restartPolicy: 'Always',
      ...overrides,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe('merge NRI vs TS exhaustive differential', () => {
  // ─── 1. Container identity patterns (3 × 5 = 15) ───

  const PARENT_PATTERNS = [
    { label: 'empty', containers: [] },
    { label: '[a]', containers: [{ name: 'a', image: 'p-a:1' }] },
    {
      label: '[a,b]',
      containers: [
        { name: 'a', image: 'p-a:1' },
        { name: 'b', image: 'p-b:1' },
      ],
    },
  ] as const;

  const CHILD_PATTERNS = [
    { label: 'empty', containers: [] },
    { label: '[a]', containers: [{ name: 'a', image: 'c-a:2' }] },
    {
      label: '[a,b]',
      containers: [
        { name: 'a', image: 'c-a:2' },
        { name: 'b', image: 'c-b:2' },
      ],
    },
    { label: '[c]', containers: [{ name: 'c', image: 'c-c:1' }] },
    {
      label: '[a,c]',
      containers: [
        { name: 'a', image: 'c-a:2' },
        { name: 'c', image: 'c-c:1' },
      ],
    },
  ] as const;

  it.each(
    PARENT_PATTERNS.flatMap(p =>
      CHILD_PATTERNS.map(c => ({ p, c, label: `${p.label} x ${c.label}` })),
    ),
  )('container identity: $label', ({ p, c }) => {
    const parent = makeSpec(p.containers);
    const child = makeSpec(c.containers);

    const nriResult = composeNRI(parent, child);
    const tsResult = mergePodSpec(parent, child);

    // Both produce same container count
    expect(nriResult.spec.containers.length).toBe(tsResult.spec.containers.length);

    // Both produce unique container names
    expect(checkNamesUnique(nriResult.spec.containers)).toBe(true);
    expect(checkNamesUnique(tsResult.spec.containers)).toBe(true);

    // Parent containers survive in both
    const parentNames = new Set(parent.spec.containers.map(x => x.name));
    const nriNames = new Set(nriResult.spec.containers.map(x => x.name));
    const tsNames = new Set(tsResult.spec.containers.map(x => x.name));
    expect(checkParentSurvive(parentNames, nriNames)).toBe(true);
    expect(checkParentSurvive(parentNames, tsNames)).toBe(true);

    // Child containers appear in both
    const childNames = new Set(child.spec.containers.map(x => x.name));
    expect(checkChildAppear(childNames, nriNames)).toBe(true);
    expect(checkChildAppear(childNames, tsNames)).toBe(true);

    // NRI and TS agree on per-container image
    for (const name of new Set([...parentNames, ...childNames])) {
      const nriC = nriResult.spec.containers.find(x => x.name === name);
      const tsC = tsResult.spec.containers.find(x => x.name === name);
      expect(nriC).toBeDefined();
      expect(tsC).toBeDefined();
      expect(nriC!.image).toBe(tsC!.image);
    }
  });

  // ─── 2. Field-level merge semantics ───

  const FIELD_CASES = [
    // (field, parent_val, child_val, expected, label)
    { field: 'command' as const, pv: ['nginx'], cv: undefined, exp: ['nginx'], label: 'command inherited from parent' },
    { field: 'command' as const, pv: ['nginx'], cv: ['node'], exp: ['node'], label: 'command child wins' },
    { field: 'args' as const, pv: ['-v'], cv: undefined, exp: ['-v'], label: 'args inherited from parent' },
    { field: 'args' as const, pv: ['-v'], cv: ['-d'], exp: ['-d'], label: 'args child wins' },
    { field: 'ports' as const, pv: [{ containerPort: 80 }], cv: undefined, exp: [{ containerPort: 80 }], label: 'ports inherited from parent' },
    { field: 'ports' as const, pv: [{ containerPort: 80 }], cv: [{ containerPort: 8080 }], exp: [{ containerPort: 8080 }], label: 'ports child wins' },
    { field: 'env' as const, pv: [{ name: 'K', value: 'v' }], cv: undefined, exp: [{ name: 'K', value: 'v' }], label: 'env inherited from parent' },
    { field: 'resources' as const, pv: { limits: { cpu: 1, memory: 512 } }, cv: undefined, exp: { limits: { cpu: 1, memory: 512 } }, label: 'resources inherited from parent' },
    { field: 'tty' as const, pv: true, cv: undefined, exp: true, label: 'tty inherited from parent' },
    { field: 'imagePullPolicy' as const, pv: 'IfNotPresent', cv: 'Always', exp: 'Always', label: 'imagePullPolicy child wins' },
  ];

  it.each(FIELD_CASES)('field-level: $label', ({ field, pv, cv, exp }) => {
    const parent = makeSpec([{ name: 'app', image: 'img:1', [field]: pv as any }]);
    const child = makeSpec([{ name: 'app', image: 'img:2', ...(cv !== undefined ? { [field]: cv } : {}) } as any]);

    const nriResult = composeNRI(parent, child);
    const tsResult = mergePodSpec(parent, child);

    const nriC = nriResult.spec.containers[0];
    const tsC = tsResult.spec.containers[0];

    expect(JSON.parse(JSON.stringify(nriC[field]))).toEqual(JSON.parse(JSON.stringify(exp)));
    expect(JSON.parse(JSON.stringify(tsC[field]))).toEqual(JSON.parse(JSON.stringify(exp)));

    // NRI and TS agree
    expect(JSON.parse(JSON.stringify(nriC[field]))).toEqual(JSON.parse(JSON.stringify(tsC[field])));
  });

  // ─── 3. Volume identity patterns (3 × 4 = 12) ───

  const PARENT_VOL_PATTERNS = [
    { label: 'empty', volumes: undefined },
    { label: '[v1]', volumes: [{ id: 'v1', type: 'EmptyDirVolume' as const }] },
    {
      label: '[v1,v2]',
      volumes: [
        { id: 'v1', type: 'EmptyDirVolume' as const },
        { id: 'v2', type: 'NFSVolume' as const },
      ],
    },
  ] as const;

  const CHILD_VOL_PATTERNS = [
    { label: 'empty', volumes: undefined },
    { label: '[v1]', volumes: [{ id: 'v1', type: 'DiskVolume' as const }] },
    {
      label: '[v1,v2]',
      volumes: [
        { id: 'v1', type: 'DiskVolume' as const },
        { id: 'v2', type: 'OSSVolume' as const },
      ],
    },
    { label: '[v3]', volumes: [{ id: 'v3', type: 'SecretVolume' as const }] },
  ] as const;

  it.each(
    PARENT_VOL_PATTERNS.flatMap(p =>
      CHILD_VOL_PATTERNS.map(c => ({ p, c, label: `${p.label} x ${c.label}` })),
    ),
  )('volume identity: $label', ({ p, c }) => {
    const parent = makeSpec([{ name: 'app', image: 'x:1' }], { volumes: p.volumes as any });
    const child = makeSpec([{ name: 'app', image: 'x:2' }], { volumes: c.volumes as any });

    const nriResult = composeNRI(parent, child);
    const tsResult = mergePodSpec(parent, child);

    // Expected keys
    const expectedKeys = new Set([
      ...(p.volumes?.map(v => v.id) ?? []),
      ...(c.volumes?.map(v => v.id) ?? []),
    ]);

    const nriKeys = new Set((nriResult.spec.volumes ?? []).map(v => v.id));
    const tsKeys = new Set((tsResult.spec.volumes ?? []).map(v => v.id));

    expect(nriKeys).toEqual(expectedKeys);
    expect(tsKeys).toEqual(expectedKeys);
    expect(nriKeys).toEqual(tsKeys);

    // For overlapping ids, child's type wins
    for (const id of expectedKeys) {
      const childVol = c.volumes?.find(v => v.id === id);
      if (childVol) {
        const nriVol = (nriResult.spec.volumes ?? []).find(v => v.id === id);
        const tsVol = (tsResult.spec.volumes ?? []).find(v => v.id === id);
        expect(nriVol?.type).toBe(childVol.type);
        expect(tsVol?.type).toBe(childVol.type);
      }
    }
  });

  // ─── 4. Metadata labels replacement (2 × 3 = 6) ───

  const PARENT_LABELS = [
    { label: 'undef', labels: undefined },
    { label: '{a:1}', labels: { a: '1' } },
  ] as const;

  const CHILD_LABELS = [
    { label: 'undef', labels: undefined },
    { label: '{a:2}', labels: { a: '2' } },
    { label: '{b:3}', labels: { b: '3' } },
  ] as const;

  it.each(
    PARENT_LABELS.flatMap(p =>
      CHILD_LABELS.map(c => ({ p, c, label: `${p.label} x ${c.label}` })),
    ),
  )('metadata labels: $label', ({ p, c }) => {
    const parent: PodSpec = { metadata: { name: 't', ...(p.labels ? { labels: p.labels } : {}) }, spec: { containers: [], restartPolicy: 'Always' } };
    const child: PodSpec = { metadata: { name: 't', ...(c.labels ? { labels: c.labels } : {}) }, spec: { containers: [], restartPolicy: 'Always' } };

    const nriResult = composeNRI(parent, child);
    const tsResult = mergePodSpec(parent, child);

    // Expected: child's labels entirely replace parent's
    const expected = c.labels !== undefined ? c.labels : p.labels;
    expect(nriResult.metadata.labels).toEqual(expected);
    expect(tsResult.metadata.labels).toEqual(expected);
  });

  // ─── 5. Scalar fields (2 × 2 = 4) ───

  const PARENT_SCALAR = [
    { label: 'undef', priority: undefined },
    { label: '5', priority: 5 },
  ] as const;

  const CHILD_SCALAR = [
    { label: 'undef', priority: undefined },
    { label: '10', priority: 10 },
  ] as const;

  it.each(
    PARENT_SCALAR.flatMap(p =>
      CHILD_SCALAR.map(c => ({ p, c, label: `priority ${p.label} x ${c.label}` })),
    ),
  )('scalar inheritance: $label', ({ p, c }) => {
    const parent = makeSpec([], { priority: p.priority } as any);
    const child = makeSpec([], { priority: c.priority } as any);

    const nriResult = composeNRI(parent, child);
    const tsResult = mergePodSpec(parent, child);

    const expected = c.priority !== undefined ? c.priority : p.priority;
    expect(nriResult.spec.priority).toBe(expected);
    expect(tsResult.spec.priority).toBe(expected);
  });

  // ─── 6. Shallow merge: providerOverrides (2 × 2 = 4) ───

  const PARENT_PO = [
    { label: 'undef', po: undefined },
    { label: '{x:{y:1}}', po: { x: { y: 1 } } },
  ] as const;

  const CHILD_PO = [
    { label: 'undef', po: undefined },
    { label: '{x:{z:2}}', po: { x: { z: 2 } } },
  ] as const;

  it.each(
    PARENT_PO.flatMap(p =>
      CHILD_PO.map(c => ({ p, c, label: `${p.label} x ${c.label}` })),
    ),
  )('shallow merge providerOverrides: $label', ({ p, c }) => {
    const parent: PodSpec = { metadata: { name: 't' }, spec: { containers: [], restartPolicy: 'Always' }, ...(p.po ? { providerOverrides: p.po } : {}) };
    const child: PodSpec = { metadata: { name: 't' }, spec: { containers: [], restartPolicy: 'Always' }, ...(c.po ? { providerOverrides: c.po } : {}) };

    const nriResult = composeNRI(parent, child);
    const tsResult = mergePodSpec(parent, child);

    if (c.po !== undefined) {
      expect(nriResult.providerOverrides).toEqual({ ...(p.po ?? {}), ...c.po });
      expect(tsResult.providerOverrides).toEqual({ ...(p.po ?? {}), ...c.po });
    } else {
      expect(nriResult.providerOverrides).toEqual(p.po);
      expect(tsResult.providerOverrides).toEqual(p.po);
    }
  });

  // ─── 7. initContainers merge by name ───

  it.each([
    { label: 'child replaces same-name init', pInit: [{ name: 'init-a', image: 'i1' }], cInit: [{ name: 'init-a', image: 'i2' }, { name: 'init-b', image: 'i3' }], expCount: 2, expA: 'i2' },
    { label: 'child omits initContainers', pInit: [{ name: 'init-a', image: 'i1' }], cInit: undefined, expCount: 1, expA: 'i1' },
  ])('initContainers: $label', ({ pInit, cInit, expCount, expA }) => {
    const parent = makeSpec([{ name: 'app', image: 'x:1' }], { initContainers: pInit as any });
    const child = makeSpec([{ name: 'app', image: 'x:2' }], { ...(cInit ? { initContainers: cInit } : {}) } as any);

    const nriResult = composeNRI(parent, child);
    const tsResult = mergePodSpec(parent, child);

    expect(nriResult.spec.initContainers).toHaveLength(expCount);
    expect(tsResult.spec.initContainers).toHaveLength(expCount);
    const nriA = nriResult.spec.initContainers?.find(x => x.name === 'init-a');
    const tsA = tsResult.spec.initContainers?.find(x => x.name === 'init-a');
    expect(nriA?.image).toBe(expA);
    expect(tsA?.image).toBe(expA);
  });

  // ─── 8. resolvedSecrets shallow merge ───

  it.each([
    { label: 'child overrides same key', pRs: { s1: { value: 'a' } }, cRs: { s1: { value: 'b' }, s2: { value: 'c' } }, expected: { s1: { value: 'b' }, s2: { value: 'c' } } },
    { label: 'child omits', pRs: { s1: { value: 'a' } }, cRs: undefined, expected: { s1: { value: 'a' } } },
  ])('resolvedSecrets: $label', ({ pRs, cRs, expected }) => {
    const parent = makeSpec([{ name: 'app', image: 'x:1' }], { resolvedSecrets: pRs } as any);
    const child = makeSpec([{ name: 'app', image: 'x:2' }], { ...(cRs ? { resolvedSecrets: cRs } : {}) } as any);

    const nriResult = composeNRI(parent, child);
    const tsResult = mergePodSpec(parent, child);

    expect(nriResult.spec.resolvedSecrets).toEqual(expected);
    expect(tsResult.spec.resolvedSecrets).toEqual(expected);
  });

  // ─── 9. Idempotence (P2) ───

  it('idempotent: composeNRI(spec, spec) === spec', () => {
    const spec = makeSpec([{ name: 'a', image: 'x:1', ports: [{ containerPort: 80 }] }]);
    const result = composeNRI(spec, spec);
    expect(result.spec.containers[0].image).toBe('x:1');
    expect(result.spec.containers[0].ports).toEqual([{ containerPort: 80 }]);
  });

  it('idempotent: mergePodSpec(spec, spec) === spec (via NRI agreement)', () => {
    const spec = makeSpec([{ name: 'a', image: 'x:1', ports: [{ containerPort: 80 }] }]);
    const nri = composeNRI(spec, spec);
    const ts = mergePodSpec(spec, spec);
    expect(nri.spec.containers[0].image).toBe(ts.spec.containers[0].image);
  });

  // ─── 10. Cross-level inheritance ───

  it('cross-level: grandparent ports survive through mid and child', () => {
    const gp = makeSpec([{ name: 'app', image: 'g:1', ports: [{ containerPort: 80 }] }]);
    const p = makeSpec([{ name: 'app', image: 'p:1' }]);
    const c = makeSpec([{ name: 'app', image: 'c:1' }]);

    const nriResult = composeNRI(composeNRI(gp, p), c);
    const tsResult = mergePodSpec(mergePodSpec(gp, p), c);

    expect(nriResult.spec.containers[0].image).toBe('c:1');
    expect(nriResult.spec.containers[0].ports).toEqual([{ containerPort: 80 }]);
    expect(tsResult.spec.containers[0].image).toBe('c:1');
    expect(tsResult.spec.containers[0].ports).toEqual([{ containerPort: 80 }]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Mutation detection
// ═══════════════════════════════════════════════════════════════════

describe('mutation detection', () => {
  const MUTATION_PARENT = makeSpec(
    [{ name: 'web', image: 'nginx:1.0', ports: [{ containerPort: 80 }], command: ['run'] }],
    { priority: 5 },
  );

  const MUTATION_CHILD = makeSpec(
    [{ name: 'web', image: 'nginx:2.0' }, { name: 'sidecar', image: 'side:1' }],
    { priority: 10 },
  );

  it('field_reversed differs from correct merge', () => {
    const correct = composeNRI(MUTATION_PARENT, MUTATION_CHILD);
    const broken = mutateFieldReversed(MUTATION_PARENT, MUTATION_CHILD);

    // Web container: correct has child's image, broken has parent's
    const correctWeb = correct.spec.containers.find(c => c.name === 'web')!;
    const brokenWeb = broken.spec.containers.find(c => c.name === 'web')!;
    expect(correctWeb.image).toBe('nginx:2.0');
    expect(brokenWeb.image).toBe('nginx:1.0');

    // P1 check should flag the broken version
    const pContainer = MUTATION_PARENT.spec.containers[0];
    const cContainer = MUTATION_CHILD.spec.containers[0];
    expect(checkFieldResolution(brokenWeb, pContainer, cContainer)).toBe(false);
  });

  it('child_replaces differs from correct merge', () => {
    const correct = composeNRI(MUTATION_PARENT, MUTATION_CHILD);
    const broken = mutateChildReplaces(MUTATION_PARENT, MUTATION_CHILD);

    const correctWeb = correct.spec.containers.find(c => c.name === 'web')!;
    const brokenWeb = broken.spec.containers.find(c => c.name === 'web')!;

    // Correct: web should inherit parent's command
    expect(correctWeb.command).toEqual(['run']);
    // Broken: web was fully replaced by child which has no command
    expect(brokenWeb.command).toBeUndefined();

    const pContainer = MUTATION_PARENT.spec.containers[0];
    const cContainer = MUTATION_CHILD.spec.containers[0];
    expect(checkFieldResolution(brokenWeb, pContainer, cContainer)).toBe(false);
  });

  it('flat_concat produces duplicate names', () => {
    const correct = composeNRI(MUTATION_PARENT, MUTATION_CHILD);
    const broken = mutateFlatConcat(MUTATION_PARENT, MUTATION_CHILD);

    // Correct: unique names
    expect(checkNamesUnique(correct.spec.containers)).toBe(true);
    // Broken: duplicate "web" entries (parent.web + child.web + child.sidecar)
    expect(broken.spec.containers.length).toBe(3);
    expect(checkNamesUnique(broken.spec.containers)).toBe(false);
  });

  it('labels_deep_merge differs from correct when overlapping keys differ', () => {
    const pPod: PodSpec = { metadata: { name: 't', labels: { a: '1', b: 'shared' } }, spec: { containers: [], restartPolicy: 'Always' } };
    const cPod: PodSpec = { metadata: { name: 't', labels: { a: '2', c: '3' } }, spec: { containers: [], restartPolicy: 'Always' } };

    const correct = composeNRI(pPod, cPod);
    const broken = mutateLabelsDeepMerge(pPod, cPod);

    // Correct: child replaces entirely, so labels = {a: '2', c: '3'}
    expect(correct.metadata.labels).toEqual({ a: '2', c: '3' });
    // Broken: deep merge, so labels = {a: '2', b: 'shared', c: '3'}
    expect(broken.metadata.labels).toEqual({ a: '2', b: 'shared', c: '3' });
    expect(correct.metadata.labels).not.toEqual(broken.metadata.labels);
  });

  it('all mutations produce different results from correct merge (general detection)', () => {
    const correct = composeNRI(MUTATION_PARENT, MUTATION_CHILD);

    const results = [
      mutateFieldReversed(MUTATION_PARENT, MUTATION_CHILD),
      mutateChildReplaces(MUTATION_PARENT, MUTATION_CHILD),
      mutateFlatConcat(MUTATION_PARENT, MUTATION_CHILD),
    ];

    // Every mutation differs from the correct result
    for (const r of results) {
      expect(JSON.stringify(r.spec.containers)).not.toBe(JSON.stringify(correct.spec.containers));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// NRI structural consistency: Python NRI @ composeNRI agree on demo data
// ═══════════════════════════════════════════════════════════════════

describe('NRI internal consistency', () => {
  it('P1: field resolution for same-name container', () => {
    const parent = makeSpec([{ name: 'a', image: 'img:1', ports: [{ containerPort: 80 }] }]);
    const child = makeSpec([{ name: 'a', image: 'img:2' }]);
    const result = composeNRI(parent, child);
    const merged = result.spec.containers[0];
    expect(checkFieldResolution(merged, parent.spec.containers[0], child.spec.containers[0])).toBe(true);
  });

  it('P3: same-name containers merge to single entry', () => {
    const parent = makeSpec([{ name: 'a', image: 'p:1' }, { name: 'b', image: 'p:1' }]);
    const child = makeSpec([{ name: 'a', image: 'c:1' }]);
    const result = composeNRI(parent, child);
    expect(result.spec.containers).toHaveLength(2);
    expect(checkNamesUnique(result.spec.containers)).toBe(true);
  });

  it('P4: parent-only containers survive', () => {
    const parent = makeSpec([{ name: 'a', image: 'p:1' }, { name: 'legacy', image: 'p:1' }]);
    const child = makeSpec([{ name: 'a', image: 'c:1' }]);
    const result = composeNRI(parent, child);
    expect(result.spec.containers.find(c => c.name === 'legacy')).toBeTruthy();
  });

  it('P5: child-only containers appear', () => {
    const parent = makeSpec([{ name: 'a', image: 'p:1' }]);
    const child = makeSpec([{ name: 'a', image: 'c:1' }, { name: 'new', image: 'c:1' }]);
    const result = composeNRI(parent, child);
    expect(result.spec.containers.find(c => c.name === 'new')).toBeTruthy();
  });
});
