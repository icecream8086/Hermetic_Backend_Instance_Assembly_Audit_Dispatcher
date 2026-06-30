// Alibaba Cloud ECI metrics provider — placeholder.
// Implements IMetricsProvider via DescribeContainerGroupMetric OpenAPI.

import type { IMetricsProvider, FetchMetricsInput, FetchMetricsResult } from '../../core/provider/interfaces.ts';

export class AlibabaEciMetricsProvider implements IMetricsProvider {
   
  public constructor(
    private readonly _accessKeyId: string,
    private readonly _accessKeySecret: string,
    private readonly _endpoint = 'eci.cn-hangzhou.aliyuncs.com',
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  public async fetchMetrics(_input: FetchMetricsInput): Promise<FetchMetricsResult> {
    throw new Error('AlibabaEciMetricsProvider.fetchMetrics not implemented');
  }
}
