import type {
  IContainerProvider,
  DescribeSandboxesInput,
  DescribeSandboxesResult,
  DeleteSandboxInput,
  GetContainerLogInput,
  ContainerLogResult,
} from '../../core/provider/interfaces.ts';
import type { CreateSandboxInput, Sandbox, NetworkInfo, ContainerRuntime, ContainerEvent } from '../../features/sandbox/types.ts';
import {
  SandboxStatus,
  createSandboxId,
} from '../../features/sandbox/types.ts';

/** In-memory stub for local development. State is lost on restart. */
export class StubContainerProvider implements IContainerProvider {
  #sandboxes = new Map<string, Sandbox>();
  #nextProviderId = 1;

  async create(input: CreateSandboxInput): Promise<{ providerId: string }> {
    const providerId = `stub-eci-${this.#nextProviderId++}`;
    const id = createSandboxId(providerId);

    const network = {
      ...(input.network.allocatePublicIp ? { publicIp: `203.0.113.${this.#nextProviderId}` } : {}),
      privateIp: `10.0.0.${this.#nextProviderId}`,
      vpcId: 'stub-vpc',
      ...(input.network.subnetIds?.[0] ? { subnetId: input.network.subnetIds[0] } : {}),
      ...(input.network.securityGroupId ? { securityGroupId: input.network.securityGroupId } : {}),
    } as NetworkInfo;

    const containers: ContainerRuntime[] = input.containers.map(c => ({
      name: c.name,
      image: c.image,
      cpu: input.resourceSpec.cpu,
      memory: input.resourceSpec.memory,
      state: { state: 'Running', ready: true, restartCount: 0 },
      volumeMounts: c.volumeMounts ?? [],
    }));

    const events: ContainerEvent[] = [{
      _brand: 'ValueObject' as const,
      reason: 'Created',
      type: 'Normal',
      message: 'Sandbox created by stub provider',
      count: 1,
    }];

    const sandbox = {
      id,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      tags: input.tags ?? [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: SandboxStatus.Running,
      version: 'stub-v1',
      config: input,
      providerId,
      network,
      containers,
      events,
    } as Sandbox;

    this.#sandboxes.set(providerId, sandbox);
    return { providerId };
  }

  async describe(input: DescribeSandboxesInput): Promise<DescribeSandboxesResult> {
    let items = [...this.#sandboxes.values()];

    if (input.sandboxId) {
      items = items.filter(s => s.id === input.sandboxId);
    }
    if (input.sandboxName) {
      items = items.filter(s => s.name.includes(input.sandboxName!));
    }
    if (input.status) {
      items = items.filter(s => s.status === input.status);
    }
    if (input.region) {
      items = items.filter(s => s.config.region === input.region);
    }

    const limit = input.limit ?? 50;
    const start = input.nextToken ? Number(input.nextToken) : 0;
    const slice = items.slice(start, start + limit);

    const hasMore = start + limit < items.length;
    return {
      sandboxes: slice,
      ...(hasMore ? { nextToken: String(start + limit) } : {}),
      totalCount: items.length,
    } as DescribeSandboxesResult;
  }

  async delete(_input: DeleteSandboxInput): Promise<void> {
    this.#sandboxes.delete(_input.providerId);
  }

  async getLogs(input: GetContainerLogInput): Promise<ContainerLogResult> {
    return {
      containerName: input.containerName,
      content: `[stub] Log output for ${input.containerName} at ${new Date().toISOString()}\n`,
      timestamp: new Date().toISOString(),
    };
  }
}
