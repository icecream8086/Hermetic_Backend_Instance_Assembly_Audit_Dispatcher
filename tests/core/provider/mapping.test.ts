import { describe, it, expect } from 'vitest';

// ─── Inline store + mapping implementation for testing ───

interface MappingRecord {
  podUid: string;
  sandboxId: string;
  providerId?: string;
  createdAt: number;
  updatedAt: number;
}

class TestPodMappingService {
  private readonly byPod = new Map<string, MappingRecord>();
  private readonly byProv = new Map<string, string>();  // providerId → sandboxId
  private readonly bySbx = new Map<string, string>();   // sandboxId → providerId

  async bind(podUid: string, sandboxId: string, providerId?: string): Promise<void> {
    const now = Date.now();
    // Clean up old provider ref if rebinding
    const old = this.byPod.get(podUid);
    if (old?.providerId) { this.byProv.delete(old.providerId); this.bySbx.delete(old.sandboxId); }
    this.byPod.set(podUid, { podUid, sandboxId, providerId, createdAt: old?.createdAt ?? now, updatedAt: now });
    if (providerId) {
      this.byProv.set(providerId, sandboxId);
      this.bySbx.set(sandboxId, providerId);
    }
  }

  async getSandboxByPod(podUid: string): Promise<string | null> {
    return this.byPod.get(podUid)?.sandboxId ?? null;
  }

  async getSandboxByProvider(providerId: string): Promise<string | null> {
    return this.byProv.get(providerId) ?? null;
  }

  async getProviderBySandbox(sandboxId: string): Promise<string | null> {
    return this.bySbx.get(sandboxId) ?? null;
  }

  async unbind(podUid: string): Promise<void> {
    const rec = this.byPod.get(podUid);
    if (rec) {
      if (rec.providerId) this.byProv.delete(rec.providerId);
      if (rec.sandboxId) this.bySbx.delete(rec.sandboxId);
      this.byPod.delete(podUid);
    }
  }
}

// ─── Tests ───

describe('PodMappingService', () => {
  it('binds podUid → sandboxId', async () => {
    const svc = new TestPodMappingService();
    await svc.bind('pod-abc-123', 'sbx-001');
    expect(await svc.getSandboxByPod('pod-abc-123')).toBe('sbx-001');
    expect(await svc.getSandboxByPod('nonexistent')).toBeNull();
  });

  it('binds podUid → sandboxId → providerId', async () => {
    const svc = new TestPodMappingService();
    await svc.bind('pod-abc-123', 'sbx-001', 'prov-runpod-xyz');
    expect(await svc.getSandboxByPod('pod-abc-123')).toBe('sbx-001');
    expect(await svc.getSandboxByProvider('prov-runpod-xyz')).toBe('sbx-001');
    expect(await svc.getProviderBySandbox('sbx-001')).toBe('prov-runpod-xyz');
  });

  it('returns null for unmapped entries', async () => {
    const svc = new TestPodMappingService();
    expect(await svc.getSandboxByPod('ghost')).toBeNull();
    expect(await svc.getSandboxByProvider('ghost')).toBeNull();
    expect(await svc.getProviderBySandbox('ghost')).toBeNull();
  });

  it('unbind removes all mapping directions', async () => {
    const svc = new TestPodMappingService();
    await svc.bind('pod-abc-123', 'sbx-001', 'prov-runpod-xyz');
    await svc.unbind('pod-abc-123');
    expect(await svc.getSandboxByPod('pod-abc-123')).toBeNull();
    expect(await svc.getSandboxByProvider('prov-runpod-xyz')).toBeNull();
    expect(await svc.getProviderBySandbox('sbx-001')).toBeNull();
  });

  it('unbind on non-existent is a no-op', async () => {
    const svc = new TestPodMappingService();
    await expect(svc.unbind('ghost')).resolves.toBeUndefined();
  });

  it('rebind updates existing mapping', async () => {
    const svc = new TestPodMappingService();
    await svc.bind('pod-abc-123', 'sbx-001', 'prov-old');
    await svc.bind('pod-abc-123', 'sbx-002', 'prov-new');
    expect(await svc.getSandboxByPod('pod-abc-123')).toBe('sbx-002');
    expect(await svc.getProviderBySandbox('sbx-002')).toBe('prov-new');
    // Old provider ref is gone
    expect(await svc.getSandboxByProvider('prov-old')).toBeNull();
  });
});

// ─── Type verification ───

describe('Type completeness', () => {
  it('PodCondition has all required fields', () => {
    const cond: import('../../../src/features/sandbox/types.ts').PodCondition = {
      type: 'Ready',
      status: 'True',
      lastTransitionTime: '2026-01-01T00:00:00Z',
    };
    expect(cond.type).toBe('Ready');
    expect(cond.status).toBe('True');
  });

  it('ProbeSpec supports httpGet and exec', () => {
    const httpProbe: import('../../../src/core/provider/types.ts').ProbeSpec = {
      httpGet: { path: '/healthz', port: 8080 },
      initialDelaySeconds: 5,
      periodSeconds: 10,
    };
    expect(httpProbe.httpGet?.path).toBe('/healthz');

    const execProbe: import('../../../src/core/provider/types.ts').ProbeSpec = {
      exec: { command: ['cat', '/tmp/healthy'] },
      failureThreshold: 3,
    };
    expect(execProbe.exec?.command).toEqual(['cat', '/tmp/healthy']);
  });

  it('EnvVar supports valueFrom references', () => {
    const env: import('../../../src/core/provider/types.ts').EnvVar = {
      name: 'DB_PASSWORD',
      valueFrom: {
        secretKeyRef: { name: 'db-secret', key: 'password' },
      },
    };
    expect(env.valueFrom?.secretKeyRef?.name).toBe('db-secret');

    const plain: import('../../../src/core/provider/types.ts').EnvVar = {
      name: 'LOG_LEVEL',
      value: 'debug',
    };
    expect(plain.value).toBe('debug');
  });

  it('ResourceRequirements supports requests and limits', () => {
    const req: import('../../../src/core/provider/types.ts').ResourceRequirements = {
      requests: { cpu: 0.5, memory: 512 },
      limits: { cpu: 2, memory: 2048, gpu: 1 },
    };
    expect(req.requests?.cpu).toBe(0.5);
    expect(req.limits?.gpu).toBe(1);
  });

  it('Sandbox type includes podUid and conditions', () => {
    // Just verify the type fields exist at compile time
    const sbx: import('../../../src/features/sandbox/types.ts').Sandbox = {
      id: {} as any,
      status: {} as any,
      version: {} as any,
      config: {} as any,
      network: {} as any,
      containers: [],
      events: [],
      podUid: 'pod-abc-123',
      conditions: [{ type: 'Ready', status: 'True' }],
    };
    expect(sbx.podUid).toBe('pod-abc-123');
    expect(sbx.conditions?.length).toBe(1);
  });

  it('ContainerConfig supports new optional fields', () => {
    const cfg: import('../../../src/features/sandbox/types.ts').ContainerConfig = {
      name: 'app',
      image: 'nginx',
      env: [{ name: 'ENV', value: 'prod' }],
      resources: { limits: { cpu: 2, memory: 1024 } },
      livenessProbe: { httpGet: { path: '/', port: 80 } },
      readinessProbe: { httpGet: { path: '/ready', port: 80 } },
    };
    expect(cfg.resources?.limits?.cpu).toBe(2);
    expect(cfg.livenessProbe?.httpGet?.path).toBe('/');
  });

  it('IVirtualNode interface is structurally valid', () => {
    // A minimal IVirtualNode implementation
    const node: import('../../../src/core/provider/interfaces.ts').IVirtualNode = {
      register: async () => {},
      deregister: async () => {},
      ping: async () => true,
      status: async () => ({
        name: 'virtual-node-0',
        provider: 'test',
        capacity: { cpu: 64, memory: 256000, podCount: 100, gpu: 8, gpuType: 'H100' },
        conditions: [{ type: 'Ready', status: 'True' }],
        ready: true,
      }),
    };
    expect(typeof node.ping).toBe('function');
  });

  it('InitContainerConfig extends ContainerConfig', () => {
    const init: import('../../../src/features/sandbox/types.ts').InitContainerConfig = {
      name: 'init-db',
      image: 'busybox',
      restartPolicy: 'OnFailure',
    };
    expect(init.name).toBe('init-db');
    expect(init.restartPolicy).toBe('OnFailure');
  });
});
