/**
 * Alibaba Cloud ECI (Elastic Container Instance) OpenAPI raw client.
 *
 * API version: 2018-08-08
 * Reference: https://api.aliyun.com/meta/v1/products/Eci/versions/2018-08-08/api-docs.json
 *
 * This client wraps ALL 36 ECI OpenAPI operations. Higher-level abstractions
 * (IContainerProvider etc.) live in eci-container.ts / eci-image.ts.
 */

import { rpcCall, type RpcParams } from './rpc.ts';

const API_VERSION = '2018-08-08';

// ─── ECI OpenAPI client ───

export class AlibabaEciApiClient {
  constructor(
    private readonly accessKeyId: string,
    private readonly accessKeySecret: string,
    private readonly endpoint = 'eci.cn-hangzhou.aliyuncs.com',
  ) {}

  // ═══════════════════════════════════════════════
  // 地域 (Region)
  // ═══════════════════════════════════════════════

  /** List available ECI regions and zones. */
  async describeRegions(params?: RpcParams): Promise<readonly any[]> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DescribeRegions', API_VERSION, params ?? {});
    return resp.Regions ?? [];
  }

  // ═══════════════════════════════════════════════
  // 容器组 (Container Group)
  // ═══════════════════════════════════════════════

  /** Create a container group. */
  async createContainerGroup(params: RpcParams): Promise<{ containerGroupId: string }> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'CreateContainerGroup', API_VERSION, params);
    return { containerGroupId: resp.ContainerGroupId ?? '' };
  }

  /** Update a container group spec. */
  async updateContainerGroup(params: RpcParams): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'UpdateContainerGroup', API_VERSION, params);
  }

  /** Describe container groups with filters. */
  async describeContainerGroups(params: RpcParams): Promise<{
    containerGroups: readonly any[];
    nextToken?: string;
    totalCount?: number;
  }> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DescribeContainerGroups', API_VERSION, params);
    return {
      containerGroups: resp.ContainerGroups ?? [],
      nextToken: resp.NextToken,
      totalCount: resp.TotalCount,
    };
  }

  /**
   * Lightweight batch status query — returns status only, no full detail.
   * Supports SinceSecond for polling.
   */
  async describeContainerGroupStatus(params: RpcParams): Promise<{
    groups: readonly any[];
    nextToken?: string;
  }> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DescribeContainerGroupStatus', API_VERSION, params);
    return {
      groups: resp.Data ?? [],
      nextToken: resp.NextToken,
    };
  }

  /** Describe container group events. */
  async describeContainerGroupEvents(params: RpcParams): Promise<readonly any[]> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DescribeContainerGroupEvents', API_VERSION, params);
    return resp.Events ?? [];
  }

  /** Resize a volume attached to a container group (currently cloud disk only). */
  async resizeContainerGroupVolume(
    containerGroupId: string, volumeName: string, newSize: number, clientToken?: string,
  ): Promise<void> {
    const params: Record<string, string> = {
      ContainerGroupId: containerGroupId,
      VolumeName: volumeName,
      NewSize: String(newSize),
    };
    if (clientToken) params.ClientToken = clientToken;
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'ResizeContainerGroupVolume', API_VERSION, params);
  }

  /** Restart a container group. */
  async restartContainerGroup(containerGroupId: string): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'RestartContainerGroup', API_VERSION, { ContainerGroupId: containerGroupId });
  }

  /** Delete a container group. */
  async deleteContainerGroup(containerGroupId: string): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DeleteContainerGroup', API_VERSION, { ContainerGroupId: containerGroupId });
  }

  // ═══════════════════════════════════════════════
  // 容器 (Container)
  // ═══════════════════════════════════════════════

  /** Execute a command in a container — returns HTTP/WebSocket URIs. */
  async execContainerCommand(
    containerGroupId: string, command: string, containerName: string,
  ): Promise<{ httpUrl: string; webSocketUri?: string }> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'ExecContainerCommand', API_VERSION, {
        ContainerGroupId: containerGroupId,
        Command: command,
        ContainerName: containerName,
      });
    return {
      httpUrl: resp.HttpUrl ?? '',
      webSocketUri: resp.WebSocketUri,
    };
  }

  /** Describe container logs. */
  async describeContainerLog(params: RpcParams): Promise<{ content: string; containerName?: string }> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DescribeContainerLog', API_VERSION, params);
    return {
      content: resp.Content ?? '',
      containerName: resp.ContainerName,
    };
  }

  /** Commit a container to an image. */
  async commitContainer(params: RpcParams): Promise<{ taskId: string }> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'CommitContainer', API_VERSION, params);
    return { taskId: resp.TaskId ?? '' };
  }

  /** Describe commit container task status. */
  async describeCommitContainerTask(params: RpcParams): Promise<{
    tasks: readonly any[];
    nextToken?: string;
  }> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DescribeCommitContainerTask', API_VERSION, params);
    return {
      tasks: resp.CommitTasks ?? [],
      nextToken: resp.NextToken,
    };
  }

  // ═══════════════════════════════════════════════
  // 镜像缓存 (Image Cache)
  // ═══════════════════════════════════════════════

  /** Create an image cache. */
  async createImageCache(params: RpcParams): Promise<{ imageCacheId: string }> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'CreateImageCache', API_VERSION, params);
    return { imageCacheId: resp.ImageCacheId ?? '' };
  }

  /** Update image cache attributes. */
  async updateImageCache(params: RpcParams): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'UpdateImageCache', API_VERSION, params);
  }

  /** Describe image caches. */
  async describeImageCaches(params: RpcParams): Promise<{
    imageCaches: readonly any[];
    totalCount?: number;
  }> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DescribeImageCaches', API_VERSION, params);
    return {
      imageCaches: resp.ImageCaches ?? [],
      totalCount: resp.TotalCount,
    };
  }

  /** Delete an image cache. */
  async deleteImageCache(imageCacheId: string): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DeleteImageCache', API_VERSION, { ImageCacheId: imageCacheId });
  }

  // ═══════════════════════════════════════════════
  // 数据缓存 (Data Cache)
  // ═══════════════════════════════════════════════

  /** Create a data cache. */
  async createDataCache(params: RpcParams): Promise<{ dataCacheId: string }> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'CreateDataCache', API_VERSION, params);
    return { dataCacheId: resp.DataCacheId ?? '' };
  }

  /** Describe data caches. */
  async describeDataCaches(params: RpcParams): Promise<{
    dataCaches: readonly any[];
    totalCount?: number;
  }> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DescribeDataCaches', API_VERSION, params);
    return {
      dataCaches: resp.DataCaches ?? [],
      totalCount: resp.TotalCount,
    };
  }

  /** Update a data cache. */
  async updateDataCache(params: RpcParams): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'UpdateDataCache', API_VERSION, params);
  }

  /** Copy a data cache across regions. */
  async copyDataCache(params: RpcParams): Promise<{ dataCacheId: string }> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'CopyDataCache', API_VERSION, params);
    return { dataCacheId: resp.DataCacheId ?? '' };
  }

  /** Delete a data cache. */
  async deleteDataCache(dataCacheId: string): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DeleteDataCache', API_VERSION, { DataCacheId: dataCacheId });
  }

  // ═══════════════════════════════════════════════
  // 虚拟节点 (Virtual Node)
  // ═══════════════════════════════════════════════

  /** Create a virtual node. */
  async createVirtualNode(params: RpcParams): Promise<{ virtualNodeId: string }> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'CreateVirtualNode', API_VERSION, params);
    return { virtualNodeId: resp.VirtualNodeId ?? '' };
  }

  /** Update a virtual node. */
  async updateVirtualNode(params: RpcParams): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'UpdateVirtualNode', API_VERSION, params);
  }

  /** Describe virtual nodes. */
  async describeVirtualNodes(params: RpcParams): Promise<{
    virtualNodes: readonly any[];
    totalCount?: number;
  }> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DescribeVirtualNodes', API_VERSION, params);
    return {
      virtualNodes: resp.VirtualNodes ?? [],
      totalCount: resp.TotalCount,
    };
  }

  /** Delete a virtual node. */
  async deleteVirtualNode(virtualNodeId: string): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DeleteVirtualNode', API_VERSION, { VirtualNodeId: virtualNodeId });
  }

  // ═══════════════════════════════════════════════
  // 监控 (Monitoring)
  // ═══════════════════════════════════════════════

  /** Describe container group metrics (CPU, memory, network). */
  async describeContainerGroupMetric(params: RpcParams): Promise<any> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DescribeContainerGroupMetric', API_VERSION, params);
  }

  /** Describe multi-dimensional metrics for a container group. */
  async describeMultiContainerGroupMetric(params: RpcParams): Promise<any> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DescribeMultiContainerGroupMetric', API_VERSION, params);
  }

  // ═══════════════════════════════════════════════
  // 运维操作 (Ops)
  // ═══════════════════════════════════════════════

  /** Create an instance ops task (coredump / tcpdump). */
  async createInstanceOpsTask(params: RpcParams): Promise<{ opsTaskId: string }> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'CreateInstanceOpsTask', API_VERSION, params);
    return { opsTaskId: resp.OpsTaskId ?? '' };
  }

  /** Describe instance ops records. */
  async describeInstanceOpsRecords(params: RpcParams): Promise<readonly any[]> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DescribeInstanceOpsRecords', API_VERSION, params);
    return resp.OpsRecords ?? [];
  }

  // ═══════════════════════════════════════════════
  // 标签 (Tags)
  // ═══════════════════════════════════════════════

  /** Tag resources. */
  async tagResources(params: RpcParams): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'TagResources', API_VERSION, params);
  }

  /** Untag resources. */
  async untagResources(params: RpcParams): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'UntagResources', API_VERSION, params);
  }

  /** List tagged resources. */
  async listTagResources(params: RpcParams): Promise<{ tagResources: readonly any[]; nextToken?: string }> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'ListTagResources', API_VERSION, params);
    return {
      tagResources: resp.TagResources ?? [],
      nextToken: resp.NextToken,
    };
  }

  // ═══════════════════════════════════════════════
  // 其他接口 (Other)
  // ═══════════════════════════════════════════════

  /** Query ECI usage quota. */
  async listUsage(params?: RpcParams): Promise<any> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'ListUsage', API_VERSION, params ?? {});
  }

  /** Get price for a container group spec. */
  async describeContainerGroupPrice(params: RpcParams): Promise<any> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DescribeContainerGroupPrice', API_VERSION, params);
  }

  /** Query available resource quotas per zone. */
  async describeAvailableResource(params: RpcParams): Promise<any> {
    return rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret,
      'DescribeAvailableResource', API_VERSION, params);
  }
}
