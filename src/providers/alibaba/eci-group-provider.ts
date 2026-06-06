/**
 * Alibaba ECI container group provider — implements IContainerGroupProvider
 * via the ECI CreateContainerGroup API.
 *
 * ECI natively supports container groups — all containers in a group share
 * the same network namespace (infra is implicit). This provider maps
 * CreateContainerGroupInput directly to ECI's API parameters.
 *
 * Uses the existing AlibabaEciContainerProvider internally for the actual
 * API calls, since the single-container and multi-container paths are
 * identical in ECI.
 */

import type {
  IContainerGroupProvider,
  DescribeContainerGroupsInput,
  DescribeContainerGroupsResult,
  CreateContainerGroupInput,
  ContainerGroupRuntime,
} from '../../core/provider/index.ts';
import { AlibabaEciContainerProvider } from './eci-container.ts';

export class AlibabaEciContainerGroupProvider implements IContainerGroupProvider {
  readonly #inner: AlibabaEciContainerProvider;

  constructor(accessKeyId: string, accessKeySecret: string, endpoint?: string) {
    this.#inner = new AlibabaEciContainerProvider(accessKeyId, accessKeySecret, endpoint);
  }

  async createGroup(input: CreateContainerGroupInput): Promise<{ providerId: string }> {
    // ECI natively supports multi-container groups — delegate directly
    return this.#inner.create(input);
  }

  async stopGroup(providerId: string): Promise<void> {
    // ECI: stop = terminal（释放资源），等同于 delete
    return this.deleteGroup(providerId);
  }

  async deleteGroup(providerId: string): Promise<void> {
    // Best-effort: try all known regions to find and delete the group
    const regions = ['cn-hangzhou', 'cn-shanghai', 'cn-beijing', 'cn-shenzhen'];
    for (const region of regions) {
      try {
        await this.#inner.delete({ region: region as any, providerId });
        return;
      } catch {
        continue;
      }
    }
  }

  async getGroupStatus(providerId: string): Promise<ContainerGroupRuntime | null> {
    return this.#inner.getStatus(providerId);
  }

  async describeGroups(input: DescribeContainerGroupsInput): Promise<DescribeContainerGroupsResult> {
    return this.#inner.describe(input);
  }
}
