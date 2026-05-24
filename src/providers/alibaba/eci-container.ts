// Alibaba Cloud ECI (Elastic Container Instance) provider.
// Implements IContainerProvider via Alibaba Cloud OpenAPI (HTTPS + HMAC-SHA1 signing).
//
// CreateContainerGroup returns immediately with a ContainerGroupId.
// The instance is Pending/Scheduling and transitions to Running asynchronously.
// Callers should poll describe() with the returned providerId.

import type {
  IContainerProvider,
  DescribeContainerGroupsInput,
  DescribeContainerGroupsResult,
  DeleteContainerGroupInput,
  GetContainerLogInput,
  ContainerLogResult,
  CreateContainerGroupInput,
} from '../../core/provider/index.ts';
import type { ContainerGroupRuntime } from '../../core/provider/index.ts';
import type { ContainerGroupStatus } from '../../core/provider/types.ts';
import { rpcCall } from './eci-signer.ts';
import { createRegionId } from '../../core/region/types.ts';

export class AlibabaEciContainerProvider implements IContainerProvider {
  constructor(
    private readonly accessKeyId: string,
    private readonly accessKeySecret: string,
    private readonly endpoint = 'eci.cn-hangzhou.aliyuncs.com',
  ) {}

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
      RestartPolicy: input.restartPolicy,
      Cpu: String(input.cpu),
      Memory: String(input.memory),
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

    // Volumes
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
      });
    }

    // Network
    params['SecurityGroupId'] = input.network.securityGroupId ?? '';
    if (input.network.subnetIds?.length) {
      params['VSwitchId'] = input.network.subnetIds[0]!;
    }

    const resp = await rpcCall(
      this.endpoint, this.accessKeyId, this.accessKeySecret,
      'CreateContainerGroup', params,
    );

    return { providerId: resp.ContainerGroupId };
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
      region: createRegionId('unknown'),
      sandboxId: providerId,
    });
    return result.sandboxes[0] ?? null;
  }
}

// ─── Mapping helpers ───

function statusToAlibaba(status: ContainerGroupStatus): string {
  switch (status) {
    case 'Pending': return 'Pending';
    case 'Scheduling': return 'Scheduling';
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
    zoneId: item.ZoneId,
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
      vswitchId: item.VSwitchId,
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
