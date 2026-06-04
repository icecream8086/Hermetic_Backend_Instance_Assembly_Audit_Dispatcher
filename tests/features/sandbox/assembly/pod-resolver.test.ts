import { describe, it, expect } from 'vitest';
import { PodResolver } from '../../../../src/features/sandbox/assembly/pod-resolver.ts';
import type { PodSpec } from '../../../../src/features/sandbox/assembly/types.ts';
import { SharedNamespace } from '../../../../src/features/sandbox/assembly/types.ts';
import { StubContainerGroupProvider } from './stub-provider.ts';

describe('PodResolver', () => {
  const provider = new StubContainerGroupProvider();
  const resolver = new PodResolver(provider);

  describe('toGroupInput', () => {
    it('converts a minimal single-service PodSpec', () => {
      const spec: PodSpec = {
        name: 'web',
        services: {
          nginx: {
            image: 'nginx:latest',
          },
        },
      };

      const input = resolver.toGroupInput(spec);

      expect(input.name).toBe('web');
      expect(input.containers).toHaveLength(1);
      expect(input.containers[0]!.name).toBe('web-nginx');
      expect(input.containers[0]!.image).toBe('nginx:latest');
      expect(input.network.allocatePublicIp).toBe(false);
    });

    it('maps all service fields correctly', () => {
      const spec: PodSpec = {
        name: 'app',
        services: {
          api: {
            image: 'my-api:1.0',
            command: 'node server.js',
            environment: { NODE_ENV: 'production', PORT: '3000' },
            ports: [{ containerPort: 3000, hostPort: 8080, protocol: 'tcp' }],
            resources: { cpu: '2', memory: '512Mi' },
            labels: { app: 'api', tier: 'backend' },
            healthCheck: {
              test: ['CMD', 'curl', '-f', 'http://localhost/health'],
              intervalSeconds: 10,
              timeoutSeconds: 5,
              retries: 3,
              startPeriodSeconds: 30,
            },
          },
        },
      };

      const input = resolver.toGroupInput(spec);

      expect(input.containers).toHaveLength(1);
      const c = input.containers[0]!;
      expect(c.name).toBe('app-api');
      expect(c.image).toBe('my-api:1.0');
      expect(c.args).toEqual(['node server.js']);
      expect(c.env).toHaveLength(2);
      expect(c.ports).toHaveLength(1);
      expect(c.ports![0]!.containerPort).toBe(3000);
      expect(c.ports![0]!.hostPort).toBe(8080);
      expect(c.resources?.limits?.cpu).toBe(2);
      expect(c.resources?.limits?.memory).toBe(512);
      expect(c.livenessProbe?.exec?.command).toEqual(['CMD', 'curl', '-f', 'http://localhost/health']);
      expect(c.livenessProbe?.periodSeconds).toBe(10);
    });

    it('handles string array commands', () => {
      const spec: PodSpec = {
        name: 'test',
        services: {
          worker: {
            image: 'worker:latest',
            command: ['npm', 'start'],
          },
        },
      };

      const input = resolver.toGroupInput(spec);
      expect(input.containers[0]!.args).toEqual(['npm', 'start']);
    });

    it('maps multiple services to multiple containers', () => {
      const spec: PodSpec = {
        name: 'stack',
        services: {
          web: { image: 'nginx:latest' },
          api: { image: 'api:latest' },
          db: { image: 'postgres:15' },
        },
      };

      const input = resolver.toGroupInput(spec);
      expect(input.containers).toHaveLength(3);
      expect(input.containers.map(c => c.name)).toEqual(['stack-web', 'stack-api', 'stack-db']);
    });

    it('maps PodSpec labels to tags', () => {
      const spec: PodSpec = {
        name: 'tagged',
        labels: { env: 'staging', team: 'infra' },
        services: {
          app: { image: 'app:latest' },
        },
      };

      const input = resolver.toGroupInput(spec);
      expect(input.tags).toHaveLength(2);
      expect(input.tags).toContainEqual({ key: 'env', value: 'staging' });
      expect(input.tags).toContainEqual({ key: 'team', value: 'infra' });
    });

    it('ignores sharedNamespaces (handled by group provider)', () => {
      const spec: PodSpec = {
        name: 'pod',
        sharedNamespaces: [SharedNamespace.NET, SharedNamespace.IPC],
        services: {
          app: { image: 'app:latest' },
        },
      };

      const input = resolver.toGroupInput(spec);
      // PodmanContainerGroupProvider always hardcodes share: [net, uts, ipc].
      // sharedNamespaces from PodSpec is intentionally not mapped here.
      expect(input.providerOverrides).toBeUndefined();
    });

    it('parses memory strings correctly', () => {
      const spec: PodSpec = {
        name: 'memtest',
        resources: { cpu: '1.5', memory: '2Gi' },
        services: {
          app: { image: 'app:latest' },
        },
      };

      const input = resolver.toGroupInput(spec);
      expect(input.cpu).toBe(1.5);
      expect(input.memory).toBe(2048); // 2Gi → 2048 MB
    });

    it('parses MiB memory correctly', () => {
      const spec: PodSpec = {
        name: 'memtest2',
        resources: { memory: '512Mi' },
        services: {
          app: { image: 'app:latest' },
        },
      };

      const input = resolver.toGroupInput(spec);
      expect(input.memory).toBe(512);
    });
  });

  describe('apply', () => {
    it('submits the PodSpec as a container group and returns providerId', async () => {
      const spec: PodSpec = {
        name: 'apply-test',
        services: {
          app: { image: 'nginx:latest' },
        },
      };

      const result = await resolver.apply(spec);
      expect(result.providerId).toBeTruthy();
      expect(typeof result.providerId).toBe('string');
    });

    it('submits multi-service PodSpecs', async () => {
      const spec: PodSpec = {
        name: 'multi-apply',
        services: {
          web: { image: 'nginx:latest' },
          api: { image: 'api:latest', dependsOn: ['web'] },
        },
      };

      const result = await resolver.apply(spec);
      expect(result.providerId).toBeTruthy();
      // Provider should have recorded the group creation
      const groups = provider.createdGroups();
      const group = groups.find(g => g.name === 'multi-apply');
      expect(group).toBeDefined();
      expect(group!.containers).toHaveLength(2);
    });
  });
});
