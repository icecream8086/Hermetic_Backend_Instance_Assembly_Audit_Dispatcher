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
import { z } from 'zod';
import type {
  CreateContainerGroupInput,
  CreateContainerGroupUpdateInput,
  ContainerGroupRuntime,
} from '../../core/provider/types.ts';
import type { ContainerGroupState } from '../../core/provider/container-lifecycle.ts';
import { rpcCall } from './eci-signer.ts';
import { createRegionId } from '../../core/region/types.ts';
import { AppError } from '../../core/types.ts';
import './eci-schema.ts'; // register Alibaba ECI extension fields
import { buildCreateParams, parseContainerGroup, decStr, decStrOpt } from './eci-codec.ts';

const cgArraySchema = z.array(z.record(z.string(), z.unknown())).optional();
const metricRecordsSchema = z.array(z.record(z.string(), z.unknown())).optional();
const metricDataSchema = z.record(z.string(), z.unknown()).optional();
const numOptSchema = z.number().optional();
function numberField(v: unknown): number | undefined { return numOptSchema.parse(v); }

export class AlibabaEciContainerProvider implements IContainerProvider {
  public readonly lifecycle: ContainerLifecycle = { stopIsDelete: true, startable: false, healthProbes: false, asyncInit: true };
  private readonly region: string;

  public constructor(
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
  public async create(input: CreateContainerGroupInput): Promise<{ providerId: string }> {
    const params = buildCreateParams(input);
    console.log('[eci] CreateContainerGroup params:', JSON.stringify(params, null, 2));
    const resp = await rpcCall(
      this.endpoint, this.accessKeyId, this.accessKeySecret,
      'CreateContainerGroup', params,
    );
    return { providerId: decStr(resp.ContainerGroupId) };
  }

  /**
   * Update an existing ECI container group via UpdateContainerGroup API.
   * Same flat-parameter pattern as create(), but only maps fields present in the input.
   */
  public async update(providerId: string, input: CreateContainerGroupUpdateInput): Promise<void> {
    const params = buildCreateParams(input, { partial: true });
    if (input.region !== undefined) {
      params.RegionId = input.region;
    } else {
      params.RegionId = this.region;
    }
    params.ContainerGroupId = providerId;
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'UpdateContainerGroup', params);
  }

  public async describe(input: DescribeContainerGroupsInput): Promise<DescribeContainerGroupsResult> {
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

    const list = cgArraySchema.parse(resp.ContainerGroups) ?? [];
    return {
      sandboxes: list.map(item => parseContainerGroup(item)),
      nextToken: decStrOpt(resp.NextToken) ?? '',
      ...(numberField(resp.TotalCount) !== undefined ? { totalCount: numberField(resp.TotalCount) } : {}),
    };
  }

  public async delete(input: DeleteContainerGroupInput): Promise<void> {
    await rpcCall(
      this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DeleteContainerGroup',
      { RegionId: input.region, ContainerGroupId: input.providerId },
    );
  }

  public async getLogs(input: GetContainerLogInput): Promise<ContainerLogResult> {
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
      content: decStr(resp.Content),
      timestamp: decStrOpt(resp.Time) ?? '',
    };
  }

  /** Get status of a single container group by provider ID. */
  public async getStatus(providerId: string): Promise<ContainerGroupRuntime | null> {
    const result = await this.describe({
      region: createRegionId(this.region),
      sandboxId: providerId,
    });
    return result.sandboxes[0] ?? null;
  }

  // ─── Container lifecycle operations ───

  public async stop(providerId: string): Promise<void> {
    await this.delete({ region: createRegionId(this.region), providerId });
  }

  public start(_providerId: string): Promise<void> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'start is not supported by Alibaba ECI (restart instead)');
  }

  public async restart(providerId: string): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'RestartContainerGroup', {
      RegionId: this.region,
      ContainerGroupId: providerId,
    });
  }

  public async kill(providerId: string): Promise<void> {
    await this.delete({ region: createRegionId(this.region), providerId });
  }

  public pause(_providerId: string): Promise<void> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'pause is not supported by Alibaba ECI');
  }

  public unpause(_providerId: string): Promise<void> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'unpause is not supported by Alibaba ECI');
  }

  public wait(_providerId: string): Promise<{ statusCode: number }> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'wait is not supported by Alibaba ECI');
  }

  public async exec(providerId: string, cmd: readonly string[], containerName?: string): Promise<{ execId: string; webSocketUri?: string }> {
    const params: Record<string, string | undefined> = {
      RegionId: 'cn-hangzhou',
      ContainerGroupId: providerId,
      Command: cmd.join(' '),
    };
    if (containerName) params.ContainerName = containerName;
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ExecContainerCommand', params);
    const wsUri = decStrOpt(resp.WebSocketUri);
    return {
      execId: decStr(resp.HttpUrl),
      ...(wsUri ? { webSocketUri: wsUri } : {}),
    };
  }

  public rename(_providerId: string): Promise<void> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'rename is not supported by Alibaba ECI');
  }

  public async stats(providerId: string): Promise<{ cpuUsage: number; memoryUsage: number; networkIO?: { rx: number; tx: number } }> {
    try {
      const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DescribeContainerGroupMetric', {
        RegionId: 'cn-hangzhou',
        ContainerGroupId: providerId,
        Period: '60',
      });
      const records = metricRecordsSchema.parse(resp.Records) ?? [];
      if (records.length === 0) return { cpuUsage: 0, memoryUsage: 0 };
      const latest = records[records.length - 1];
      if (!latest) return { cpuUsage: 0, memoryUsage: 0 };

      const cpu = metricDataSchema.parse(latest.CPU);
      const mem = metricDataSchema.parse(latest.Memory);
      const net = metricDataSchema.parse(latest.Network);

      const cpuUsage = numOptSchema.parse(cpu?.UsageInNanocores) ?? 0;
      const memoryUsage = numOptSchema.parse(mem?.Rss) ?? 0;
      return net
        ? { cpuUsage, memoryUsage, networkIO: { rx: numOptSchema.parse(net.RxBytes) ?? 0, tx: numOptSchema.parse(net.TxBytes) ?? 0 } }
        : { cpuUsage, memoryUsage };
    } catch (_e) {
      const emptyStats: { cpuUsage: number; memoryUsage: number } = { cpuUsage: 0, memoryUsage: 0 };
      return emptyStats;
    }
  }

  public top(_providerId: string): Promise<{ processes: readonly (readonly string[])[] }> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'top is not supported by Alibaba ECI');
  }
}

// ─── Re-exports (codec-driven mapping) ───

export { parseContainerGroup };

function statusToAlibaba(status: ContainerGroupState): string {
  // ContainerGroupState enum values are already their ECI API string representations
  return status;
}
