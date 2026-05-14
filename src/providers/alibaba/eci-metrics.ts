// Alibaba Cloud ECI metrics provider — placeholder.
// Implements IMetricsProvider via DescribeContainerGroupMetric OpenAPI.

import type { IMetricsProvider, FetchMetricsInput, FetchMetricsResult } from '../../core/provider/interfaces.ts';

export class AlibabaEciMetricsProvider implements IMetricsProvider {
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

  async fetchMetrics(_input: FetchMetricsInput): Promise<FetchMetricsResult> {
    throw new Error('AlibabaEciMetricsProvider.fetchMetrics not implemented');
  }
}
