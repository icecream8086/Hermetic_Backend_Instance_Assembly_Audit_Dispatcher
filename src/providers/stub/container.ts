import type {
  IContainerProvider,
  DescribeContainerGroupsInput,
  DescribeContainerGroupsResult,
  DeleteContainerGroupInput,
  GetContainerLogInput,
  ContainerLogResult,
  ContainerGroupRuntime,
  ContainerGroupRuntimeEvent,
  AssociatedResource,
  OciContainer,
} from '../../core/provider/index.ts';
import type { CreateContainerGroupInput, ContainerId } from '../../core/provider/types.ts';
import type { ZoneId } from '../../core/region/types.ts';
import { StubOciRuntime } from '../../features/ociruntime/oci-runtime.stub.ts';
import type { OciCreateSpec } from '../../features/ociruntime/types.ts';

/** In-memory stub for local development. State is lost on restart. */
export class StubContainerProvider implements IContainerProvider {
  #runtimes = new Map<string, ContainerGroupRuntime>();
  #oci = new StubOciRuntime();
  #nameToOciId = new Map<string, ContainerId>();
  #nextProviderId = 1;

  async create(input: CreateContainerGroupInput): Promise<{ providerId: string }> {
    const providerId = `stub-eci-${this.#nextProviderId++}`;

    // Delegate container lifecycle to the OCI runtime
    const ociContainers: OciContainer[] = [];
    for (const c of input.containers) {
      const spec: OciCreateSpec = {
        name: c.name,
        image: c.image,
        args: c.args,
        env: {},
        workingDir: '/',
        labels: {},
        annotations: {},
        mounts: (c.volumeMounts ?? []).map(vm => ({
          source: `/mnt/${vm.volumeId}`,
          destination: vm.mountPath,
          options: vm.readOnly ? ['ro'] : [],
        })),
        ports: [],
        resources: { cpu: input.cpu, memory: input.memory },
      };
      const created = await this.#oci.createContainer(spec);
      await this.#oci.startContainer(created.id);
      const inspected = await this.#oci.inspectContainer(created.id);
      if (inspected) {
        ociContainers.push(inspected);
        this.#nameToOciId.set(c.name, inspected.id);
      }
    }

    const now = new Date().toISOString();
    const events: ContainerGroupRuntimeEvent[] = [{
      reason: 'Created',
      type: 'Normal' as const,
      message: 'Container group created by stub provider',
      count: 1,
      lastTimestamp: now,
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
      instanceId: undefined,
      zoneId: 'stub-zone-a' as ZoneId,
      instanceType: 'ecs.g6.large',
      spotStrategy: input.spotStrategy,
      cpu: input.cpu,
      memory: input.memory,
      network: {
        privateIp: `10.0.0.${this.#nextProviderId}`,
        vpcId: 'stub-vpc',
        ...(input.network.subnetIds?.[0] ? { subnetId: input.network.subnetIds[0] } : {}),
        ...(input.network.securityGroupId ? { securityGroupId: input.network.securityGroupId } : {}),
      },
      associatedResources,
      restartPolicy: input.restartPolicy,
      containers: ociContainers,
      volumes: (input.volumes ?? []).map(v => ({
        name: v.id,
        type: 'NFSVolume',
        ...(v.options ? { nfs: v.options as { server: string; path: string; readOnly: boolean } } : {}),
      })),
      events,
      tags: (input.tags ?? []).map(t => ({ key: t.key, value: t.value })),
    };

    this.#runtimes.set(providerId, runtime);
    return { providerId };
  }

  async describe(input: DescribeContainerGroupsInput): Promise<DescribeContainerGroupsResult> {
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

  async delete(input: DeleteContainerGroupInput): Promise<void> {
    this.#runtimes.delete(input.providerId);
  }

  async getLogs(input: GetContainerLogInput): Promise<ContainerLogResult> {
    const ociId = this.#nameToOciId.get(input.containerName);
    if (ociId) {
      const tail = input.limitBytes ? Math.min(input.limitBytes, 100) : undefined;
      const content = await this.#oci.getLogs(ociId, tail !== undefined ? { tail } : undefined);
      return { containerName: input.containerName, content, timestamp: new Date().toISOString() };
    }
    return {
      containerName: input.containerName,
      content: `[stub] Log output for ${input.containerName} at ${new Date().toISOString()}\n`,
      timestamp: new Date().toISOString(),
    };
  }
}
