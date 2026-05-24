import type { IContainerProvider } from '../../../core/provider/interfaces.ts';
import type { CreateContainerGroupInput } from '../../../core/provider/types.ts';
import { createRegionId } from '../../../core/region/types.ts';
import type { IInfraManager } from './interfaces.ts';

/** Default infra (pause) image — smallest possible container that holds namespaces. */
const DEFAULT_INFRA_IMAGE = 'k8s.gcr.io/pause:3.6';
const LOCAL_REGION = createRegionId('local');

/**
 * Manages infra (pause) containers that hold shared kernel namespaces for a Pod.
 *
 * An infra container is a minimal container that does nothing but occupy
 * network / UTS / IPC / cgroup namespaces. Application containers in the same
 * Pod join these namespaces via `NetworkMode: container:<infra-id>`.
 *
 * For local Podman: creates a standalone pause container.
 * For cloud providers (ECI): infra is implicit (the container group itself
 * acts as the namespace anchor), so this manager is a no-op.
 */
export class InfraManager implements IInfraManager {
  readonly #containerProvider: IContainerProvider;

  constructor(containerProvider: IContainerProvider) {
    this.#containerProvider = containerProvider;
  }

  async createInfra(podName: string, infraImage?: string): Promise<string> {
    const input: CreateContainerGroupInput = {
      name: `${podName}-infra`,
      region: LOCAL_REGION,
      cpu: 0.1,
      memory: 16,
      spotStrategy: 'None',
      restartPolicy: 'Never',
      containers: [
        {
          name: 'infra',
          image: infraImage ?? DEFAULT_INFRA_IMAGE,
          args: [],
          tty: false,
          stdin: false,
          imagePullPolicy: 'IfNotPresent',
        },
      ],
      network: {
        allocatePublicIp: false,
      },
      tags: [{ key: 'role', value: 'infra' }, { key: 'managed-by', value: 'hbi-aad' }, { key: 'pod', value: podName }],
      providerOverrides: { purpose: 'infra' },
    };

    const { providerId } = await this.#containerProvider.create(input);
    return providerId;
  }

  async removeInfra(infraId: string): Promise<void> {
    await this.#containerProvider.delete({
      region: LOCAL_REGION,
      providerId: infraId,
    });
  }

  async isInfraAlive(infraId: string): Promise<boolean> {
    try {
      const status = await this.#containerProvider.getStatus?.(infraId);
      return status?.containers.some(c => c.alive) ?? false;
    } catch {
      return false;
    }
  }
}
