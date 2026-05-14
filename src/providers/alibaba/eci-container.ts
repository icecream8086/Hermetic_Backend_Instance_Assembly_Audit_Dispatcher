// Alibaba Cloud ECI (Elastic Container Instance) provider — placeholder.
// Implements IContainerProvider via Alibaba Cloud OpenAPI (HTTPS + HMAC-SHA1 signing).

import type { IContainerProvider, DescribeSandboxesInput, DescribeSandboxesResult, DeleteSandboxInput, GetContainerLogInput, ContainerLogResult } from '../../core/provider/interfaces.ts';
import type { CreateSandboxInput } from '../../features/sandbox/types.ts';

export class AlibabaEciContainerProvider implements IContainerProvider {
  // @ts-expect-error — fields stored for HMAC signing (not yet wired)
  #accessKeyId: string;
  // @ts-expect-error
  #accessKeySecret: string;
  // @ts-expect-error
  #endpoint: string;

  constructor(accessKeyId: string, accessKeySecret: string, endpoint = 'eci.cn-hangzhou.aliyuncs.com') {
    this.#accessKeyId = accessKeyId;
    this.#accessKeySecret = accessKeySecret;
    this.#endpoint = endpoint;
  }

  async create(_input: CreateSandboxInput): Promise<{ providerId: string }> {
    throw new Error('AlibabaEciContainerProvider.create not implemented');
  }

  async describe(_input: DescribeSandboxesInput): Promise<DescribeSandboxesResult> {
    throw new Error('AlibabaEciContainerProvider.describe not implemented');
  }

  async delete(_input: DeleteSandboxInput): Promise<void> {
    throw new Error('AlibabaEciContainerProvider.delete not implemented');
  }

  async getLogs(_input: GetContainerLogInput): Promise<ContainerLogResult> {
    throw new Error('AlibabaEciContainerProvider.getLogs not implemented');
  }
}
