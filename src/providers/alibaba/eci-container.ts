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
import { createRegionId, createZoneId } from '../../core/region/types.ts';
import { AppError } from '../../core/types.ts';
import { applyExtensionOverrides } from '../../core/provider/extension-schema.ts';
import './eci-schema.ts'; // register Alibaba ECI extension fields

export class AlibabaEciContainerProvider implements IContainerProvider {
  readonly lifecycle: ContainerLifecycle = { stopIsDelete: true, startable: false, healthProbes: false, asyncInit: true };
  private readonly region: string;

  constructor(
    private readonly accessKeyId: string,
    private readonly accessKeySecret: string,
    private readonly endpoint = 'eci.cn-hangzhou.aliyuncs.com',
  ) {
    // Extract region from endpoint: eci.cn-hangzhou.aliyuncs.com → cn-hangzhou
    const m = endpoint.match(/eci\.([^.]+)\./);
    this.region = m?.[1] ?? 'cn-hangzhou';
  }

  /**
   * Create an ECI container group.
   *
   * The API responds immediately with a ContainerGroupId, but the actual
   * instance may still be Pending/Scheduling.  Call describe() to poll.
   */
  async create(input: CreateContainerGroupInput): Promise<{ providerId: string }> {
    const params: Record<string, string> = {
      RegionId: input.region,
      ContainerGroupName: input.name,
      ...(input.zoneId ? { ZoneId: input.zoneId } : {}),
      RestartPolicy: input.restartPolicy,
      Cpu: String(input.cpu),
      Memory: String(input.memory),
      ...(input.gpu && input.gpu > 0 ? {
        GpuSpecs: JSON.stringify([{ Count: input.gpu, Type: input.gpuType ?? 'nvidia.com/gpu' }]),
      } : {}),
    };

    // Spot strategy
    if (input.spotStrategy && input.spotStrategy !== 'None') {
      params.SpotStrategy = input.spotStrategy;
    }

    // Containers
    input.containers.forEach((c, i) => {
      const idx = `Container.${i + 1}`;
      params[`${idx}.Name`] = c.name;
      params[`${idx}.Image`] = c.image;
      if (c.command?.length) {
        params[`${idx}.Command`] = c.command.join(' ');
      }
      if (c.args?.length) {
        params[`${idx}.Args`] = c.args.join(' ');
      }
      if (c.imagePullPolicy) {
        params[`${idx}.ImagePullPolicy`] = c.imagePullPolicy;
      }
      // Environment
      if (c.env?.length) {
        c.env.forEach((e, j) => {
          const eidx = `${idx}.EnvironmentVar.${j + 1}`;
          params[`${eidx}.Key`] = e.name;
          if (e.value !== undefined) {
            params[`${eidx}.Value`] = e.value;
          } else if (e.valueFrom?.fieldRef) {
            params[`${eidx}.FieldRefFieldPath`] = e.valueFrom.fieldRef.fieldPath;
          }
        });
      }
      // Resources
      if (c.resources) {
        if (c.resources.limits) {
          params[`${idx}.Cpu`] = String(c.resources.limits.cpu);
          params[`${idx}.Memory`] = String(c.resources.limits.memory);
        }
      }
      // Ports
      if (c.ports) {
        c.ports.forEach((p, pi) => {
          params[`${idx}.Port.${pi + 1}.Port`] = String(p.containerPort);
          if (p.protocol) params[`${idx}.Port.${pi + 1}.Protocol`] = p.protocol;
        });
      }
      // Liveness probe
      if (c.livenessProbe) {
        const lp = c.livenessProbe;
        if (lp.tcpSocket) {
          params[`${idx}.LivenessProbe.TcpSocket.Port`] = String(lp.tcpSocket.port);
        }
        if (lp.httpGet) {
          params[`${idx}.LivenessProbe.HttpGet.Path`] = lp.httpGet.path;
          params[`${idx}.LivenessProbe.HttpGet.Port`] = String(lp.httpGet.port);
          if (lp.httpGet.scheme) params[`${idx}.LivenessProbe.HttpGet.Scheme`] = lp.httpGet.scheme;
        }
        if (lp.exec) {
          params[`${idx}.LivenessProbe.Exec.Commands`] = lp.exec.command.join(' ');
        }
        if (lp.initialDelaySeconds) params[`${idx}.LivenessProbe.InitialDelaySeconds`] = String(lp.initialDelaySeconds);
        if (lp.periodSeconds) params[`${idx}.LivenessProbe.PeriodSeconds`] = String(lp.periodSeconds);
        if (lp.timeoutSeconds) params[`${idx}.LivenessProbe.TimeoutSeconds`] = String(lp.timeoutSeconds);
        if (lp.failureThreshold) params[`${idx}.LivenessProbe.FailureThreshold`] = String(lp.failureThreshold);
        if (lp.successThreshold) params[`${idx}.LivenessProbe.SuccessThreshold`] = String(lp.successThreshold);
      }
    });

    // Volumes — handles NFS, OSS (S3), Disk, ConfigMap, Secret
    if (input.volumes?.length) {
      input.volumes.forEach((v, i) => {
        const vidx = `Volume.${i + 1}`;
        params[`${vidx}.Name`] = v.id;
        params[`${vidx}.Type`] = v.type;
        const volOpts = v.options as Record<string, unknown> | undefined;
        if (volOpts?.server) {
          // NFS volume
          params[`${vidx}.NFSVolume.Server`] = String(volOpts.server);
          params[`${vidx}.NFSVolume.Path`] = String(volOpts.path ?? '');
          if (volOpts.readOnly) params[`${vidx}.NFSVolume.ReadOnly`] = 'true';
        }
        if (volOpts?.bucket) {
          // OSS volume (S3-compatible)
          params[`${vidx}.Type`] = 'OSSVolume';
          params[`${vidx}.OSSVolume.Bucket`] = String(volOpts.bucket);
          if (volOpts.path) params[`${vidx}.OSSVolume.Path`] = String(volOpts.path);
          if (volOpts.readOnly) params[`${vidx}.OSSVolume.ReadOnly`] = 'true';
          if (volOpts.endpoint) params[`${vidx}.OSSVolume.Endpoint`] = String(volOpts.endpoint);
        }
        if (volOpts?.diskId) {
          // Cloud disk (云盘) — persistent block storage
          params[`${vidx}.DiskVolume.DiskId`] = String(volOpts.diskId);
          params[`${vidx}.DiskVolume.FsType`] = String(volOpts.fsType ?? 'ext4');
          if (volOpts.sizeGiB) params[`${vidx}.DiskVolume.DiskSize`] = String(volOpts.sizeGiB);
          if (volOpts.diskCategory) params[`${vidx}.DiskVolume.DiskCategory`] = String(volOpts.diskCategory);
          if (volOpts.readOnly) params[`${vidx}.DiskVolume.ReadOnly`] = 'true';
          if (volOpts.deleteWithInstance) params[`${vidx}.DiskVolume.DeleteWithInstance`] = 'true';
        }
        if (v.type === 'ConfigMapVolume' || volOpts?.configMapName) {
          // Legacy ConfigMap — replaced by env-var injection, kept for backward compat with existing sandbox status
          const name = String(volOpts?.configMapName ?? volOpts?.name ?? '');
          const items = (volOpts?.items as Array<{ key: string; path: string; mode?: number }> | undefined) ?? [];
          params[`${vidx}.ConfigMapVolume.Name`] = name;
          items.forEach((item, j) => {
            params[`${vidx}.ConfigMapVolume.Items.${j + 1}.Key`] = item.key;
            params[`${vidx}.ConfigMapVolume.Items.${j + 1}.Path`] = item.path;
            if (item.mode !== undefined) params[`${vidx}.ConfigMapVolume.Items.${j + 1}.Mode`] = String(item.mode);
          });
        }
        if (v.type === 'SecretVolume' || volOpts?.secretName) {
          // Secret — inject sensitive data as files
          const name = String(volOpts?.secretName ?? volOpts?.name ?? '');
          const items = (volOpts?.items as Array<{ key: string; path: string; mode?: number }> | undefined) ?? [];
          params[`${vidx}.SecretVolume.SecretName`] = name;
          items.forEach((item, j) => {
            params[`${vidx}.SecretVolume.Items.${j + 1}.Key`] = item.key;
            params[`${vidx}.SecretVolume.Items.${j + 1}.Path`] = item.path;
            if (item.mode !== undefined) params[`${vidx}.SecretVolume.Items.${j + 1}.Mode`] = String(item.mode);
          });
        }
      });
    }

    // Network — multi-zone via comma-separated VSwitchIds
    params['SecurityGroupId'] = input.network.securityGroupId ?? '';
    if (input.network.subnetIds?.length) {
      params['VSwitchId'] = input.network.subnetIds.join(',');
      params['ScheduleStrategy'] = 'VSwitchRandom';
      delete params['ZoneId'];
    }
    // Public IP
    if (input.network.allocatePublicIp) {
      params['AutoCreateEip'] = 'true';
      if (input.network.publicIpBandwidth) params['EipBandwidth'] = String(input.network.publicIpBandwidth);
    }
    // Image cache
    params['AutoMatchImageCache'] = 'true';

    // Extension fields (providerOverrides) — maps Alibaba-specific params via schema
    if (input.providerOverrides) {
      const ext = applyExtensionOverrides('alibaba', input.providerOverrides);
      for (const [k, v] of Object.entries(ext)) {
        params[k] = v;
      }
    }

    try {
      const resp = await rpcCall(
        this.endpoint, this.accessKeyId, this.accessKeySecret,
        'CreateContainerGroup', params,
      );
      return { providerId: resp.ContainerGroupId };
    } catch (e) {
      console.error('[eci] CreateContainerGroup params:', JSON.stringify(params, null, 2));
      throw e;
    }
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

// ─── Mapping helpers ───

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

function parseContainerGroup(item: any): ContainerGroupRuntime {
  const containers: any[] = item.Containers ?? [];
  return {
    providerId: item.ContainerGroupId ?? '',
    name: item.ContainerGroupName ?? '',
    status: item.Status ?? 'Pending',
    regionId: item.RegionId ?? '',
    instanceId: undefined,
    zoneId: createZoneId(item.ZoneId ?? 'cn-hangzhou-a', 'alibaba'),
    creationTime: item.CreationTime,
    expiredTime: item.ExpiredTime,
    instanceType: item.InstanceType,
    spotStrategy: item.SpotStrategy,
    cpu: item.Cpu ?? 0,
    memory: item.Memory ?? 0,
    discount: item.Discount,
    network: {
      privateIp: item.PrivateIp,
      vpcId: item.VpcId,
      subnetId: item.VSwitchId,
      securityGroupId: item.SecurityGroupId,
      eniId: item.EniInstanceId,
    },
    associatedResources: [],
    restartPolicy: item.RestartPolicy ?? 'Always',
    containers: containers.map((c: any) => ({
      id: c.ContainerId ?? '',
      name: c.Name ?? '',
      image: c.Image ?? '',
      args: c.Args ?? [],
      env: c.EnvironmentVars?.reduce?.((acc: any, e: any) => ({ ...acc, [e.Key ?? '']: e.Value ?? '' }), {}) ?? {},
      workingDir: c.WorkingDir ?? '',
      status: c.Status ?? 'creating',
      alive: c.Status === 'Running',
      createdAt: c.CreationTime ?? '',
      startedAt: c.StartedAt,
      finishedAt: c.FinishedAt,
      exitCode: c.ExitCode,
      labels: {},
      annotations: {},
      mounts: [],
      resources: c.Cpu || c.Memory ? { cpu: c.Cpu ?? 0, memory: c.Memory ?? 0 } : undefined,
      health: { status: c.Status === 'Running' ? 'healthy' : 'starting' },
    })),
    volumes: item.Volumes?.map?.((v: any) => ({
      name: v.Name ?? '',
      type: v.Type ?? '',
      nfs: v.NFSVolume ? { server: v.NFSVolume.Server ?? '', path: v.NFSVolume.Path ?? '', readOnly: !!v.NFSVolume.ReadOnly } : undefined,
    })) ?? [],
    events: item.Events?.map?.((e: any) => ({
      reason: e.Reason ?? '',
      type: e.Type ?? 'Normal',
      message: e.Message ?? '',
      count: e.Count ?? 0,
      lastTimestamp: e.LastTimestamp,
    })) ?? [],
    tags: item.Tags?.map?.((t: any) => ({ key: t.Key ?? '', value: t.Value ?? '' })) ?? [],
  };
}
