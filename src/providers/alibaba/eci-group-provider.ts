/**
 * Alibaba ECI container group provider — implements IContainerGroupProvider.
 * Uses AlibabaPodCodec (CEA) for v3 PodSpec, delegates to inner provider for legacy operations.
 */

import type {
  IContainerGroupProvider,
  DescribeContainerGroupsInput,
  DescribeContainerGroupsResult,
} from '../../core/provider/interfaces.ts';
import type { CreateContainerGroupInput, ContainerGroupRuntime } from '../../core/provider/types.ts';
import type { PodSpec } from '../../core/pod/types.ts';
import { AlibabaPodCodec } from './pod-codec.ts';
import { rpcCall } from './eci-signer.ts';

export class AlibabaEciContainerGroupProvider implements IContainerGroupProvider {
  private readonly accessKeyId: string;
  private readonly accessKeySecret: string;
  private readonly endpoint: string;
  private readonly region: string;

  public constructor(accessKeyId: string, accessKeySecret: string, endpoint?: string) {
    this.accessKeyId = accessKeyId;
    this.accessKeySecret = accessKeySecret;
    this.endpoint = endpoint ?? 'eci.cn-hangzhou.aliyuncs.com';
    const m = /eci\.([^.]+)\./.exec(this.endpoint);
    this.region = m?.[1] ?? 'cn-hangzhou';
  }

  public async createPod(spec: PodSpec): Promise<{ providerId: string }> {
    const codec = new AlibabaPodCodec(this.region);
    const params = codec.encode(spec);
    const resp = await rpcCall(
      this.endpoint, this.accessKeyId, this.accessKeySecret,
      'CreateContainerGroup', params,
    );
    const rawId = resp.ContainerGroupId;
    return { providerId: typeof rawId === 'string' ? rawId : '' };
  }

  /** @deprecated Use createPod(PodSpec) instead. */
  public async createGroup(input: CreateContainerGroupInput): Promise<{ providerId: string }> {
    const { AlibabaEciContainerProvider: Inner } = await import('./eci-container.ts');
    return new Inner(this.accessKeyId, this.accessKeySecret, this.endpoint).create(input);
  }

  public async stopGroup(providerId: string): Promise<void> {
    return this.deleteGroup(providerId);
  }

  public async deleteGroup(providerId: string): Promise<void> {
    const regions = ['cn-hangzhou', 'cn-shanghai', 'cn-beijing', 'cn-shenzhen'];
    for (const region of regions) {
      try {
        const { AlibabaEciContainerProvider: Inner } = await import('./eci-container.ts');
        await new Inner(this.accessKeyId, this.accessKeySecret, this.endpoint).delete({ region: region as any, providerId });
        return;
      } catch { continue; }
    }
  }

  public async getGroupStatus(providerId: string): Promise<ContainerGroupRuntime | null> {
    const { AlibabaEciContainerProvider: Inner } = await import('./eci-container.ts');
    return new Inner(this.accessKeyId, this.accessKeySecret, this.endpoint).getStatus(providerId);
  }

  public async describeGroups(input: DescribeContainerGroupsInput): Promise<DescribeContainerGroupsResult> {
    const { AlibabaEciContainerProvider: Inner } = await import('./eci-container.ts');
    return new Inner(this.accessKeyId, this.accessKeySecret, this.endpoint).describe(input);
  }
}
