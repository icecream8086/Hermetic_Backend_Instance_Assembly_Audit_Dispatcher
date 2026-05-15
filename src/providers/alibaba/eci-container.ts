// Alibaba Cloud ECI (Elastic Container Instance) provider.
// Implements IContainerProvider via Alibaba Cloud OpenAPI (HTTPS + HMAC-SHA1 signing).
// Reference: catch/script0/alibaba_l4d2_runtime_test.py (create + describe + delete)
//           catch/script0/alibaba_get_info.py (DescribeContainerGroups response parsing)
//           catch/script0/alibaba_get_log.py (DescribeContainerLog)

import type {
  IContainerProvider,
  DescribeContainerGroupsInput,
  DescribeContainerGroupsResult,
  DeleteContainerGroupInput,
  GetContainerLogInput,
  ContainerLogResult,
} from '../../core/provider/index.ts';
import type { CreateContainerGroupInput } from '../../core/provider/index.ts';

export class AlibabaEciContainerProvider implements IContainerProvider {
  constructor(
    _accessKeyId: string,
    _accessKeySecret: string,
    _endpoint = 'eci.cn-hangzhou.aliyuncs.com',
  ) {}

  async create(_input: CreateContainerGroupInput): Promise<{ providerId: string }> {
    // TODO: implement via Alibaba ECI CreateContainerGroup API
    // See catch/script0/alibaba_l4d2_runtime_test.py for reference
    throw new Error('AlibabaEciContainerProvider.create not implemented');
  }

  async describe(_input: DescribeContainerGroupsInput): Promise<DescribeContainerGroupsResult> {
    // TODO: implement via Alibaba ECI DescribeContainerGroups API
    // See catch/script0/alibaba_get_info.py for reference.
    // Parse the response body into ContainerGroupRuntime[].
    throw new Error('AlibabaEciContainerProvider.describe not implemented');
  }

  async delete(_input: DeleteContainerGroupInput): Promise<void> {
    // TODO: implement via Alibaba ECI DeleteContainerGroup API
    // See catch/script0/alibaba_free_resource.py for reference
    throw new Error('AlibabaEciContainerProvider.delete not implemented');
  }

  async getLogs(_input: GetContainerLogInput): Promise<ContainerLogResult> {
    // TODO: implement via Alibaba ECI DescribeContainerLog API
    // See catch/script0/alibaba_get_log.py for reference
    throw new Error('AlibabaEciContainerProvider.getLogs not implemented');
  }
}
