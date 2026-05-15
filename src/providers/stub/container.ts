import type {
  IContainerProvider,
  DescribeSandboxesInput,
  DescribeSandboxesResult,
  DeleteSandboxInput,
  GetContainerLogInput,
  ContainerLogResult,
  ContainerGroupRuntime,
  ContainerRuntimeInfo,
  ContainerGroupRuntimeEvent,
  AssociatedResource,
} from '../../core/provider/index.ts';
import type { CreateSandboxInput } from '../../features/sandbox/types.ts';

/** In-memory stub for local development. State is lost on restart. */
export class StubContainerProvider implements IContainerProvider {
  #runtimes = new Map<string, ContainerGroupRuntime>();
  #nextProviderId = 1;

  async create(input: CreateSandboxInput): Promise<{ providerId: string }> {
    const providerId = `stub-eci-${this.#nextProviderId++}`;

    const containers: ContainerRuntimeInfo[] = input.containers.map(c => ({
      name: c.name,
      image: c.image,
      args: c.args ?? [],
      cpu: input.resourceSpec.cpu,
      memory: input.resourceSpec.memory,
      ready: true,
      restartCount: 0,
      state: { state: 'Running' as const, startTime: new Date().toISOString() },
      volumeMounts: (c.volumeMounts ?? []).map(vm => ({
        name: String(vm.volumeId),
        mountPath: vm.mountPath,
        readOnly: vm.readOnly,
        ...(vm.mountPropagation !== undefined ? { mountPropagation: vm.mountPropagation } : {}),
      })),
    }));

    const events: ContainerGroupRuntimeEvent[] = [{
      reason: 'Created',
      type: 'Normal' as const,
      message: 'Container group created by stub provider',
      count: 1,
      lastTimestamp: new Date().toISOString(),
    }];

    const publicIp = input.network.allocatePublicIp ? `203.0.113.${this.#nextProviderId}` : undefined;
    const associatedResources: AssociatedResource[] = publicIp ? [{
      type: 'eip',
      resourceId: `eip-${providerId}`,
      ip: publicIp,
      bandwidth: input.network.publicIpBandwidth ?? 19,
      isp: 'BGP',
      status: 'InUse',
    }] : [];

    const runtime: ContainerGroupRuntime = {
      providerId,
      name: input.name,
      status: 'Running',
      regionId: input.region,
      zoneId: 'stub-zone-a',
      instanceType: 'ecs.g6.large',
      spotStrategy: input.spotStrategy,
      cpu: input.resourceSpec.cpu,
      memory: input.resourceSpec.memory,
      network: {
        privateIp: `10.0.0.${this.#nextProviderId}`,
        vpcId: 'stub-vpc',
        ...(input.network.subnetIds?.[0] ? { vswitchId: input.network.subnetIds[0] } : {}),
        ...(input.network.securityGroupId ? { securityGroupId: input.network.securityGroupId } : {}),
      },
      associatedResources,
      restartPolicy: input.restartPolicy,
      containers,
      volumes: (input.volumes ?? []).map(v => ({
        name: String(v.id),
        type: 'NFSVolume',
        ...(v.nfs ? { nfs: { server: v.nfs.server, path: v.nfs.path, readOnly: v.nfs.readOnly } } : {}),
      })),
      events,
      tags: (input.tags ?? []).map(t => ({ key: t.key, value: t.value })),
    };

    this.#runtimes.set(providerId, runtime);
    return { providerId };
  }

  async describe(input: DescribeSandboxesInput): Promise<DescribeSandboxesResult> {
    let items = [...this.#runtimes.values()];

    if (input.sandboxId) {
      items = items.filter(r => r.providerId === String(input.sandboxId));
    }
    if (input.sandboxName) {
      items = items.filter(r => r.name.includes(input.sandboxName!));
    }
    if (input.status) {
      items = items.filter(r => r.status === input.status);
    }
    if (input.region) {
      items = items.filter(r => r.regionId === input.region);
    }

    const limit = input.limit ?? 50;
    const start = input.nextToken ? Number(input.nextToken) : 0;
    const slice = items.slice(start, start + limit);

    const hasMore = start + limit < items.length;
    return {
      sandboxes: slice,
      ...(hasMore ? { nextToken: String(start + limit) } : {}),
      totalCount: items.length,
    };
  }

  async delete(input: DeleteSandboxInput): Promise<void> {
    this.#runtimes.delete(input.providerId);
  }

  async getLogs(input: GetContainerLogInput): Promise<ContainerLogResult> {
    return {
      containerName: input.containerName,
      content: `[stub] Log output for ${input.containerName} at ${new Date().toISOString()}\n`,
      timestamp: new Date().toISOString(),
    };
  }
}
