// Alibaba Cloud ECI (Elastic Container Instance) provider.
// Implements IContainerProvider via Alibaba Cloud OpenAPI (HTTPS + HMAC-SHA1 signing).
//
// CreateContainerGroup returns immediately with a ContainerGroupId.
// The instance is Pending/Scheduling and transitions to Running asynchronously.
// Callers should poll describe() with the returned providerId.

import type {
  IContainerProvider,
  ContainerLifecycle,
  DescribeContainerGroupsInput,
  DescribeContainerGroupsResult,
  DeleteContainerGroupInput,
  GetContainerLogInput,
  ContainerLogResult,
} from '../../core/provider/interfaces.ts';
import type {
  CreateContainerGroupInput,
  ContainerGroupRuntime,
  ContainerGroupStatus,
} from '../../core/provider/types.ts';
import { rpcCall } from './eci-signer.ts';
import { createRegionId } from '../../core/region/types.ts';
import { AppError } from '../../core/types.ts';
import './eci-schema.ts'; // register Alibaba ECI extension fields
import { buildCreateParams, parseContainerGroup } from './eci-codec.ts';

export class AlibabaEciContainerProvider implements IContainerProvider {
  readonly lifecycle: ContainerLifecycle = { stopIsDelete: true, startable: false, healthProbes: false, asyncInit: true };
  private readonly region: string;

  constructor(
    private readonly accessKeyId: string,
    private readonly accessKeySecret: string,
    private readonly endpoint = 'eci.cn-hangzhou.aliyuncs.com',
  ) {
    // Extract region from endpoint: eci.cn-hangzhou.aliyuncs.com → cn-hangzhou
    const m = /eci\.([^.]+)\./.exec(endpoint);
    this.region = m?.[1] ?? 'cn-hangzhou';
  }

  /**
   * Create an ECI container group.
   *
   * The API responds immediately with a ContainerGroupId, but the actual
   * instance may still be Pending/Scheduling.  Call describe() to poll.
   */
  async create(input: CreateContainerGroupInput): Promise<{ providerId: string }> {
    const params = buildCreateParams(input);
    console.log('[eci] CreateContainerGroup params:', JSON.stringify(params, null, 2));
    const resp = await rpcCall(
      this.endpoint, this.accessKeyId, this.accessKeySecret,
      'CreateContainerGroup', params,
    );
    return { providerId: resp.ContainerGroupId };
  }

  /**
   * Update an existing ECI container group via UpdateContainerGroup API.
   * Same flat-parameter pattern as create(), but only maps fields present in the input.
   */
  async update(providerId: string, input: Partial<CreateContainerGroupInput>): Promise<void> {
    const params = buildCreateParams(input as CreateContainerGroupInput, { partial: true });
    params.RegionId = (input.region as string | undefined) ?? this.region;
    params.ContainerGroupId = providerId;
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'UpdateContainerGroup', params);
  }

  async describe(input: DescribeContainerGroupsInput): Promise<DescribeContainerGroupsResult> {
    const params: Record<string, string> = {
      RegionId: input.region,
    };
    if (input.sandboxName) params.ContainerGroupName = input.sandboxName;
    if (input.sandboxId) params.ContainerGroupIds = JSON.stringify([input.sandboxId]);
    if (input.status) params.Status = statusToAlibaba(input.status);
    if (input.nextToken) params.NextToken = input.nextToken;
    if (input.limit) params.Limit = String(input.limit);
    else params.Limit = '20';

    const resp = await rpcCall(
      this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DescribeContainerGroups', params,
    );

    const list: any[] = resp.ContainerGroups ?? [];
    return {
      sandboxes: list.map(item => parseContainerGroup(item)),
      nextToken: resp.NextToken,
      totalCount: resp.TotalCount,
    };
  }

  async delete(input: DeleteContainerGroupInput): Promise<void> {
    await rpcCall(
      this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DeleteContainerGroup',
      { RegionId: input.region, ContainerGroupId: input.providerId },
    );
  }

  async getLogs(input: GetContainerLogInput): Promise<ContainerLogResult> {
    const params: Record<string, string> = {
      RegionId: input.region,
      ContainerGroupId: input.providerId,
      ContainerName: input.containerName,
    };
    if (input.limitBytes) params.Tail = String(input.limitBytes);
    if (input.sinceSeconds) params.SinceSeconds = String(input.sinceSeconds);
    if (input.timestamps) params.Timestamps = 'true';

    const resp = await rpcCall(
      this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DescribeContainerLog', params,
    );

    return {
      containerName: input.containerName,
      content: resp.Content ?? '',
      timestamp: resp.Time,
    };
  }

  /** Get status of a single container group by provider ID. */
  async getStatus(providerId: string): Promise<ContainerGroupRuntime | null> {
    const result = await this.describe({
      region: createRegionId(this.region),
      sandboxId: providerId,
    });
    return result.sandboxes[0] ?? null;
  }

  // ─── Container lifecycle operations ───

  async stop(providerId: string): Promise<void> {
    await this.delete({ region: createRegionId(this.region), providerId });
  }

  async start(_providerId: string): Promise<void> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'start is not supported by Alibaba ECI (restart instead)');
  }

  async restart(providerId: string): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'RestartContainerGroup', {
      RegionId: this.region,
      ContainerGroupId: providerId,
    });
  }

  async kill(providerId: string): Promise<void> {
    await this.delete({ region: createRegionId(this.region), providerId });
  }

  async pause(_providerId: string): Promise<void> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'pause is not supported by Alibaba ECI');
  }

  async unpause(_providerId: string): Promise<void> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'unpause is not supported by Alibaba ECI');
  }

  async wait(_providerId: string): Promise<{ statusCode: number }> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'wait is not supported by Alibaba ECI');
  }

  async exec(providerId: string, cmd: readonly string[], containerName?: string): Promise<{ execId: string; webSocketUri?: string }> {
    const params: Record<string, string | undefined> = {
      RegionId: 'cn-hangzhou',
      ContainerGroupId: providerId,
      Command: cmd.join(' '),
    };
    if (containerName) params.ContainerName = containerName;
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ExecContainerCommand', params);
    return {
      execId: resp.HttpUrl ?? '',
      webSocketUri: resp.WebSocketUri,
    };
  }

  async rename(_providerId: string): Promise<void> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'rename is not supported by Alibaba ECI');
  }

  async stats(providerId: string): Promise<{ cpuUsage: number; memoryUsage: number; networkIO?: { rx: number; tx: number } }> {
    try {
      const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DescribeContainerGroupMetric', {
        RegionId: 'cn-hangzhou',
        ContainerGroupId: providerId,
        Period: '60',
      });
      const records: any[] = resp.Records ?? [];
      if (records.length === 0) return { cpuUsage: 0, memoryUsage: 0 };
      const latest = records[records.length - 1]!;
      const cpuUsage = latest.CPU?.UsageInNanocores ?? 0;
      const memoryUsage = latest.Memory?.Rss ?? 0;
      const net = latest.Network;
      return net
        ? { cpuUsage, memoryUsage, networkIO: { rx: net.RxBytes ?? 0, tx: net.TxBytes ?? 0 } }
        : { cpuUsage, memoryUsage };
    } catch {
      return { cpuUsage: 0, memoryUsage: 0 };
    }
  }

  async top(_providerId: string): Promise<{ processes: readonly (readonly string[])[] }> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'top is not supported by Alibaba ECI');
  }
}

// ─── Re-exports (codec-driven mapping) ───

export { parseContainerGroup };

function statusToAlibaba(status: ContainerGroupStatus): string {
  switch (status) {
    case 'Pending': return 'Pending';
    case 'Scheduling': return 'Scheduling';
    case 'ScheduleFailed': return 'ScheduleFailed';
    case 'Running': return 'Running';
    case 'Succeeded': return 'Succeeded';
    case 'Failed': return 'Failed';
    case 'Expiring': return 'Expiring';
    case 'Expired': return 'Expired';
    case 'Restarting': return 'Restarting';
    default: return 'Pending';
  }
}
