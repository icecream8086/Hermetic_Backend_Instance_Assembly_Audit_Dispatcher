import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PodmanContainerProvider } from '../../../src/providers/podman/podman-provider.ts';
import type { CreateContainerGroupInput, ContainerGroupRuntime } from '../../../src/core/provider/types.ts';

const PODMAN_ENDPOINT = process.env['PODMAN_ENDPOINT'] ?? 'http://192.168.45.202:8080';

describe('Podman nginx lifecycle', () => {
  let provider: PodmanContainerProvider;
  let providerId: string;
  let runtime: ContainerGroupRuntime | null;

  beforeAll(async () => {
    provider = new PodmanContainerProvider(PODMAN_ENDPOINT);
    const input: CreateContainerGroupInput = {
      name: `test-nginx-${Date.now()}`,
      region: 'local' as any,
      cpu: 0.5, memory: 128,
      spotStrategy: 'None', restartPolicy: 'OnFailure',
      containers: [{ name: 'nginx', image: 'docker.io/library/nginx:latest', resources: { limits: { cpu: 0.5, memory: 128 } }, ports: [{ containerPort: 80, protocol: 'TCP' as const }] }],
      network: { allocatePublicIp: false },
    } as CreateContainerGroupInput;
    const result = await provider.create(input);
    providerId = result.providerId;
    await new Promise(r => setTimeout(r, 2000));
    runtime = await provider.getStatus!(providerId);
    console.log(`Created ${providerId}, running=${runtime?.containers[0]?.alive}`);
  }, 30000);

  afterAll(async () => {
    if (providerId) {
      await provider.delete({ region: 'local' as any, providerId }).catch(() => {});
    }
  });

  it('container is Running', () => {
    expect(runtime).not.toBeNull();
    expect(runtime!.containers.length).toBeGreaterThan(0);
    expect(runtime!.containers[0]!.alive).toBe(true);
  });

  it('getLogs returns output', async () => {
    const logs = await provider.getLogs({ providerId, containerName: runtime!.containers[0]!.name });
    expect(logs.content.length).toBeGreaterThan(0);
  });

  it('delete removes the container', async () => {
    await provider.delete({ region: 'local' as any, providerId });
    const s = await provider.getStatus!(providerId);
    expect(s).toBeNull();
    providerId = '';
  });
});
