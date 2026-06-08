import { describe, it, expect } from 'vitest';
import { sanitizeProbe, sanitizeContainerInput, secureContainerProvider, secureContainerGroupProvider } from '../../../src/core/provider/security.ts';
import type { IContainerProvider, IContainerGroupProvider } from '../../../src/core/provider/interfaces.ts';
import type { CreateContainerGroupInput, ContainerCreateConfig, ProbeSpec } from '../../../src/core/provider/types.ts';

// ─── sanitizeProbe ───

describe('sanitizeProbe', () => {
  it('strips shell metacharacters from exec command', () => {
    const input: ProbeSpec = { exec: { command: ['echo', 'hello; rm -rf /'] } };
    const result = sanitizeProbe(input);
    expect(result.exec!.command[1]).toBe('hello rm -rf /');
  });

  it('strips shell metacharacters from httpGet path', () => {
    const input: ProbeSpec = { httpGet: { port: 80, path: '/path;rm' } };
    const result = sanitizeProbe(input);
    expect((result.httpGet as any).path).toBe('/pathrm');
  });

  it('coerces port to number for httpGet', () => {
    const input: ProbeSpec = { httpGet: { port: '8080' as any, path: '/health' } };
    const result = sanitizeProbe(input);
    expect((result.httpGet as any).port).toBe(8080);
  });

  it('coerces port to number for tcpSocket', () => {
    const input: ProbeSpec = { tcpSocket: { port: '3306' as any } };
    const result = sanitizeProbe(input);
    expect((result.tcpSocket as any).port).toBe(3306);
  });

  it('passes through unknown probe types', () => {
    const input: ProbeSpec = {};
    const result = sanitizeProbe(input);
    expect(result).toEqual({});
  });
});

// ─── sanitizeContainerInput ───

describe('sanitizeContainerInput', () => {
  it('sanitizes all probes across all containers', () => {
    const input: CreateContainerGroupInput = {
      name: 'test',
      cpu: 1, memory: 512,
      region: 'local' as any,
      spotStrategy: 'None',
      restartPolicy: 'Always',
      containers: [{
        name: 'c1',
        image: 'nginx',
        livenessProbe: { exec: { command: ['ls', ';rm'] } },
        readinessProbe: { exec: { command: ['echo', '$(whoami)'] } },
      }],
      network: {} as any,
    };
    const result = sanitizeContainerInput(input);
    expect(result.containers[0].livenessProbe!.exec!.command[1]).toBe('rm');
    // $(whoami) → shell meta stripped → whoami (letters remain)
    expect(result.containers[0].readinessProbe!.exec!.command[1]).toBe('whoami');
  });
});

// ─── secureContainerProvider (Proxy 正确性) ───

describe('secureContainerProvider', () => {
  const requiredMethods: (keyof IContainerProvider)[] = [
    'create', 'describe', 'delete', 'getLogs',
  ];
  const optionalMethods: (keyof IContainerProvider)[] = [
    'getStatus', 'stop', 'start', 'restart', 'kill',
    'pause', 'unpause', 'wait', 'exec', 'rename', 'stats', 'top', 'update',
  ];

  it('exposes all required interface methods as functions', () => {
    const inner: IContainerProvider = {
      create: async () => ({ providerId: 'p1' }),
      describe: async () => ({ sandboxes: [] }),
      delete: async () => {},
      getLogs: async () => ({ containerName: 'c', content: '' }),
    };
    const secured = secureContainerProvider(inner);

    for (const m of requiredMethods) {
      expect(typeof (secured as any)[m]).toBe('function');
    }
  });

  it('exposes optional methods when present on inner', () => {
    const inner: IContainerProvider = {
      create: async () => ({ providerId: 'p1' }),
      describe: async () => ({ sandboxes: [] }),
      delete: async () => {},
      getLogs: async () => ({ containerName: 'c', content: '' }),
      stop: async () => {},
      getStatus: async () => null,
    };
    const secured = secureContainerProvider(inner);

    expect(typeof (secured as any).stop).toBe('function');
    expect(typeof (secured as any).getStatus).toBe('function');
  });

  it('returns undefined for missing optional methods', () => {
    const inner: IContainerProvider = {
      create: async () => ({ providerId: 'p1' }),
      describe: async () => ({ sandboxes: [] }),
      delete: async () => {},
      getLogs: async () => ({ containerName: 'c', content: '' }),
    };
    const secured = secureContainerProvider(inner);

    // stop 不存在 → Proxy 从 prototype 取不到 → undefined
    expect((secured as any).stop).toBeUndefined();
  });

  it('wraps create with sanitization', async () => {
    const inner: IContainerProvider = {
      create: async (input) => {
        // Verify the input was sanitized before reaching inner
        const probe = input.containers[0]!.livenessProbe!;
        expect(probe.exec!.command[1]).toBe('rm');
        return { providerId: 'p1' };
      },
      describe: async () => ({ sandboxes: [] }),
      delete: async () => {},
      getLogs: async () => ({ containerName: 'c', content: '' }),
    };
    const secured = secureContainerProvider(inner);

    await secured.create({
      name: 'test', cpu: 1, memory: 256,
      region: 'local' as any, spotStrategy: 'None', restartPolicy: 'Always',
      containers: [{
        name: 'c', image: 'n',
        livenessProbe: { exec: { command: ['ls', ';rm'] } },
      }],
      network: {} as any,
    });
  });
});

// ─── secureContainerGroupProvider ───

describe('secureContainerGroupProvider', () => {
  const requiredMethods: (keyof IContainerGroupProvider)[] = [
    'createGroup', 'stopGroup', 'deleteGroup', 'getGroupStatus', 'describeGroups',
  ];

  it('exposes all interface methods as functions', () => {
    const inner: IContainerGroupProvider = {
      createGroup: async () => ({ providerId: 'p1' }),
      stopGroup: async () => {},
      deleteGroup: async () => {},
      getGroupStatus: async () => null,
      describeGroups: async () => ({ sandboxes: [] }),
    };
    const secured = secureContainerGroupProvider(inner);

    for (const m of requiredMethods) {
      expect(typeof (secured as any)[m]).toBe('function');
    }
  });
});
