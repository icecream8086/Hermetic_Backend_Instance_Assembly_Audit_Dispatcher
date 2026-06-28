// Alibaba Cloud ECI metrics provider — placeholder.
// Implements IMetricsProvider via DescribeContainerGroupMetric OpenAPI.

import type { IMetricsProvider, FetchMetricsInput, FetchMetricsResult } from '../../core/provider/interfaces.ts';

export class AlibabaEciMetricsProvider implements IMetricsProvider {
  public constructor(
    _accessKeyId: string,
    _accessKeySecret: string,
    _endpoint = 'eci.cn-hangzhou.aliyuncs.com',
  ) {}

  public async fetchMetrics(_input: FetchMetricsInput): Promise<FetchMetricsResult> {
    throw new Error('AlibabaEciMetricsProvider.fetchMetrics not implemented');
  }
}
