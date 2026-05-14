import { describe, it, expect } from 'vitest';
import { resolveAssembly } from '../../../src/features/sandbox/assembly/resolver.ts';
import type { Template } from '../../../src/features/sandbox/assembly/types.ts';

// ─── Test helpers ───

function makeStore(entries: [string, Template][]): Map<string, Template> {
  return new Map(entries);
}

function containerT(name: string, image: string): Template {
  return {
    name,
    kind: 'container',
    version: '1.0.0',
    spec: { name: `ctr-${name}`, image },
  } as Template;
}

function resourceT(name: string, resourceType: string, spec: Record<string, unknown>): Template {
  return {
    name,
    kind: 'resource',
    version: '1.0.0',
    resourceType,
    spec,
  } as Template;
}

function assemblyT(
  name: string,
  components: { target: string; mergeStrategy: 'merge' | 'override' | 'append' }[],
  overrides?: Record<string, unknown>,
): Template {
  return {
    name,
    kind: 'assembly',
    version: '1.0.0',
    components,
    overrides,
  } as Template;
}

// ─── Successful assembly ───

describe('resolveAssembly', () => {
  describe('successful resolution', () => {
    it('resolves a flat assembly with one container and overrides', () => {
      const store = makeStore([
        ['web', containerT('web', 'nginx:latest')],
        ['main', assemblyT('main', [{ target: 'web', mergeStrategy: 'merge' }], {
          name: 'my-server',
          region: 'us-east-1',
          resourceSpec: { cpu: 1, memory: 1 },
          restartPolicy: 'Always' as const,
        })],
      ]);

      const result = resolveAssembly('main', store);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.config.name).toBe('my-server');
      expect(result.config.region).toBe('us-east-1');
      expect(result.config.resourceSpec.cpu).toBe(1);
      expect(result.config.containers).toHaveLength(1);
      expect(result.config.containers[0]!.image).toBe('nginx:latest');
    });

    it('merges multiple containers from different templates', () => {
      const store = makeStore([
        ['app', containerT('app', 'node:20')],
        ['sidecar', containerT('sidecar', 'envoy:1.28')],
        ['main', assemblyT('main', [
          { target: 'app', mergeStrategy: 'merge' },
          { target: 'sidecar', mergeStrategy: 'merge' },
        ], {
          name: 'svc',
          region: 'eu-west-1',
          resourceSpec: { cpu: 2, memory: 4 },
          restartPolicy: 'Always' as const,
        })],
      ]);

      const result = resolveAssembly('main', store);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.config.containers).toHaveLength(2);
      expect(result.config.containers.map(c => c.image)).toContain('node:20');
      expect(result.config.containers.map(c => c.image)).toContain('envoy:1.28');
    });

    it('merges resource templates into providerOverrides', () => {
      const store = makeStore([
        ['web', containerT('web', 'alpine')],
        ['dns', resourceT('dns', 'dns', { zone: 'example.com' })],
        ['net', resourceT('net', 'network', { vpc: 'vpc-123' })],
        ['main', assemblyT('main', [
          { target: 'web', mergeStrategy: 'merge' },
          { target: 'dns', mergeStrategy: 'merge' },
          { target: 'net', mergeStrategy: 'merge' },
        ], {
          name: 's',
          region: 'r',
          resourceSpec: { cpu: 1, memory: 1 },
          restartPolicy: 'Always' as const,
        })],
      ]);

      const result = resolveAssembly('main', store);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.config.providerOverrides).toBeDefined();
      expect(result.config.providerOverrides!['dns']).toEqual({ zone: 'example.com' });
      expect(result.config.providerOverrides!['network']).toEqual({ vpc: 'vpc-123' });
    });

    it('resolves nested assemblies (transitive dependencies)', () => {
      const store = makeStore([
        ['web', containerT('web', 'nginx')],
        ['sub', assemblyT('sub', [{ target: 'web', mergeStrategy: 'merge' }])],
        ['main', assemblyT('main', [{ target: 'sub', mergeStrategy: 'merge' }], {
          name: 'nested',
          region: 'ap-south-1',
          resourceSpec: { cpu: 1, memory: 2 },
          restartPolicy: 'Always' as const,
        })],
      ]);

      const result = resolveAssembly('main', store);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.config.containers).toHaveLength(1);
      expect(result.config.containers[0]!.image).toBe('nginx');
    });

    it('overrides duplicate container configs (last wins)', () => {
      const store = makeStore([
        ['base', containerT('base', 'ubuntu:22.04')],
        ['custom', ({
          name: 'custom',
          kind: 'container',
          version: '1.0.0',
          spec: { name: 'ctr-base', image: 'ubuntu:24.04', tty: true },
        } as Template)],
        ['main', assemblyT('main', [
          { target: 'base', mergeStrategy: 'merge' },
          { target: 'custom', mergeStrategy: 'merge' },
        ], {
          name: 'c',
          region: 'r',
          resourceSpec: { cpu: 1, memory: 1 },
          restartPolicy: 'Always' as const,
        })],
      ]);

      const result = resolveAssembly('main', store);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.config.containers).toHaveLength(1);
      // 'custom' template overrides 'base' because it has the same container name
      expect(result.config.containers[0]!.image).toBe('ubuntu:24.04');
      expect(result.config.containers[0]!.tty).toBe(true);
    });
  });

  // ─── Error cases ───

  describe('error handling', () => {
    it('returns failure for a missing root template', () => {
      const store = makeStore([]);
      const result = resolveAssembly('nonexistent', store);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.templateName).toBe('nonexistent');
    });

    it('returns failure for a missing dependency', () => {
      const store = makeStore([
        ['main', assemblyT('main', [{ target: 'missing-dep', mergeStrategy: 'merge' }])],
      ]);
      const result = resolveAssembly('main', store);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(result.errors.some(e => e.message.includes('not found'))).toBe(true);
    });

    it('detects simple cycles (A → B → A)', () => {
      const store = makeStore([
        ['a', assemblyT('a', [{ target: 'b', mergeStrategy: 'merge' }])],
        ['b', assemblyT('b', [{ target: 'a', mergeStrategy: 'merge' }])],
      ]);
      const result = resolveAssembly('a', store);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(result.errors.some(e => e.message.includes('Circular dependency'))).toBe(true);
    });

    it('detects self-referencing cycles', () => {
      const store = makeStore([
        ['self', assemblyT('self', [{ target: 'self', mergeStrategy: 'merge' }])],
      ]);
      const result = resolveAssembly('self', store);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(result.errors.some(e => e.message.includes('Circular dependency'))).toBe(true);
    });

    it('returns failure for empty container list', () => {
      const store = makeStore([
        ['main', assemblyT('main', [], {
          name: 'empty',
          region: 'r',
          resourceSpec: { cpu: 1, memory: 1 },
          restartPolicy: 'Always' as const,
        })],
      ]);
      const result = resolveAssembly('main', store);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(result.errors.some(e => e.message.includes('at least one container'))).toBe(true);
    });

    it('returns failure for zero CPU', () => {
      const store = makeStore([
        ['web', containerT('web', 'alpine')],
        ['main', assemblyT('main', [{ target: 'web', mergeStrategy: 'merge' }], {
          name: 's',
          region: 'r',
          resourceSpec: { cpu: 0, memory: 1 },
          restartPolicy: 'Always' as const,
        })],
      ]);
      const result = resolveAssembly('main', store);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(result.errors.some(e => e.message.includes('cpu'))).toBe(true);
    });

    it('returns failure for missing name', () => {
      const store = makeStore([
        ['web', containerT('web', 'alpine')],
        ['main', assemblyT('main', [{ target: 'web', mergeStrategy: 'merge' }], {
          name: '',
          region: 'r',
          resourceSpec: { cpu: 1, memory: 1 },
          restartPolicy: 'Always' as const,
        })],
      ]);
      const result = resolveAssembly('main', store);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(result.errors.some(e => e.message.includes('name'))).toBe(true);
    });
  });

  // ─── Edge cases ───

  describe('edge cases', () => {
    it('handles diamond dependencies (B and C both depend on D, A depends on B and C)', () => {
      const store = makeStore([
        ['d', containerT('d', 'base-image')],
        ['b', assemblyT('b', [{ target: 'd', mergeStrategy: 'merge' }])],
        ['c', assemblyT('c', [{ target: 'd', mergeStrategy: 'merge' }])],
        ['a', assemblyT('a', [
          { target: 'b', mergeStrategy: 'merge' },
          { target: 'c', mergeStrategy: 'merge' },
        ], {
          name: 'diamond',
          region: 'r',
          resourceSpec: { cpu: 1, memory: 1 },
          restartPolicy: 'Always' as const,
        })],
      ]);

      const result = resolveAssembly('a', store);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      // Container from 'd' should appear exactly once (dedup)
      expect(result.config.containers).toHaveLength(1);
    });

    it('handles deeply nested assemblies', () => {
      const names = ['l0', 'l1', 'l2', 'l3', 'l4'];
      const store = new Map<string, Template>();
      store.set('leaf', containerT('leaf', 'scratch'));

      // l0 → leaf, l1 → l0, ..., only root (l4) carries overrides
      for (let i = 0; i < names.length; i++) {
        const deps = i === 0
          ? [{ target: 'leaf', mergeStrategy: 'merge' as const }]
          : [{ target: names[i - 1]!, mergeStrategy: 'merge' as const }];
        const overrides = i === names.length - 1 ? {
          name: 'deep',
          region: 'r',
          resourceSpec: { cpu: 1, memory: 1 },
          restartPolicy: 'Always' as const,
        } : undefined;
        store.set(names[i]!, assemblyT(names[i]!, deps, overrides));
      }

      const result = resolveAssembly('l4', store);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.config.containers).toHaveLength(1);
    });

    it('resolving a standalone container template fails validation (missing overrides)', () => {
      const store = makeStore([
        ['web', containerT('web', 'alpine')],
      ]);
      const result = resolveAssembly('web', store);
      // 'web' is a container template, not an assembly — no overrides applied
      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      // Validation errors for missing name, region, resourceSpec
      expect(result.errors.some(e => e.message.includes('name'))).toBe(true);
      expect(result.errors.some(e => e.message.includes('region'))).toBe(true);
      expect(result.errors.some(e => e.message.includes('cpu'))).toBe(true);
      expect(result.errors.some(e => e.message.includes('memory'))).toBe(true);
    });

    it('multiple resource templates of same type merge correctly', () => {
      const store = makeStore([
        ['web', containerT('web', 'alpine')],
        ['dns-a', resourceT('dns-a', 'dns', { zone: 'a.com', ttl: 60 })],
        ['dns-b', resourceT('dns-b', 'dns', { zone: 'b.com', proxied: true })],
        ['main', assemblyT('main', [
          { target: 'web', mergeStrategy: 'merge' },
          { target: 'dns-a', mergeStrategy: 'merge' },
          { target: 'dns-b', mergeStrategy: 'merge' },
        ], {
          name: 's',
          region: 'r',
          resourceSpec: { cpu: 1, memory: 1 },
          restartPolicy: 'Always' as const,
        })],
      ]);

      const result = resolveAssembly('main', store);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      // Later template (dns-b) overrides zone
      expect(result.config.providerOverrides!['dns']).toEqual({
        zone: 'b.com',
        ttl: 60,
        proxied: true,
      });
    });
  });
});
