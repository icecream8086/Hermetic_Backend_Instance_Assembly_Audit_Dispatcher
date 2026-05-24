/**
 * Podman REST API provider — implements IContainerProvider via Docker v1.24 API.
 *
 * Creates and manages individual containers. For multi-container pod/group
 * operations see PodmanContainerGroupProvider (podman-group-provider.ts).
 *
 * Endpoint defaults to http://127.0.0.1:8080 (podman's default API port).
 */

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

interface PodmanContainer {
  Id: string;
  Names?: string[];
  Image?: string;
  ImageID?: string;
  State?: string;
  Status?: string;
  Created?: number;
  Ports?: Array<{
    containerPort: number;
    hostPort?: number;
    protocol?: string;
  }>;
  Labels?: Record<string, string>;
  Mounts?: Array<{
    Source: string;
    Destination: string;
    Mode?: string;
    RW?: boolean;
  }>;
}

interface PodmanInspectResult {
  Id: string;
  Name: string;
  State: {
    Status: string;
    Running: boolean;
    Paused: boolean;
    StartedAt?: string;
    FinishedAt?: string;
    ExitCode?: number;
    Error?: string;
  };
  Config: {
    Image: string;
    Cmd?: string[];
    Env?: string[];
    WorkingDir?: string;
    Labels?: Record<string, string>;
  };
  HostConfig: {
    PortBindings?: Record<string, Array<{ HostPort?: string }>>;
    RestartPolicy?: { Name?: string };
    NetworkMode?: string;
  };
  Mounts?: Array<{
    Source: string;
    Destination: string;
    Type?: string;
    Mode?: string;
  }>;
  NetworkSettings?: {
    IPAddress?: string;
  };
  Created: string;
}

export class PodmanContainerProvider implements IContainerProvider {
  readonly #apiBase: string;

  constructor(endpoint = 'http://127.0.0.1:8080') {
    this.#apiBase = `${endpoint}/v1.24`;
  }

  // ─── IContainerProvider ───

  async create(input: CreateContainerGroupInput): Promise<{ providerId: string }> {
    const c = input.containers[0]!;

    // Env: flatten to KEY=VALUE strings
    const env: string[] = [];
    if (c?.env) {
      for (const e of c.env) {
        if (e.value !== undefined) env.push(`${e.name}=${e.value}`);
      }
    }

    // Port mappings
    const exposedPorts: Record<string, Record<string, unknown>> = {};
    const portBindings: Record<string, Array<{ HostPort?: string }>> = {};
    if (c?.ports) {
      for (const p of c.ports) {
        const key = `${p.containerPort}/${p.protocol ?? 'tcp'}`;
        exposedPorts[key] = {};
        portBindings[key] = p.hostPort !== undefined ? [{ HostPort: String(p.hostPort) }] : [{}];
      }
    }

    // Health check from livenessProbe
    let healthcheck: Record<string, unknown> | undefined;
    if (c?.livenessProbe) {
      const lp = c.livenessProbe;
      if (lp.exec) {
        healthcheck = { Test: ['CMD', ...lp.exec.command] };
      } else if (lp.httpGet) {
        healthcheck = { Test: ['CMD', 'curl', '-sf', `http://localhost:${lp.httpGet.port}${lp.httpGet.path ?? '/'}`] };
      } else if (lp.tcpSocket) {
        healthcheck = { Test: ['CMD', '/bin/bash', '-c', `exec 3<>/dev/tcp/localhost/${lp.tcpSocket.port} || exit 1`] };
      }
      if (healthcheck) {
        if (lp.initialDelaySeconds) healthcheck.StartPeriod = lp.initialDelaySeconds * 1_000_000_000;
        if (lp.periodSeconds) healthcheck.Interval = lp.periodSeconds * 1_000_000_000;
        if (lp.timeoutSeconds) healthcheck.Timeout = lp.timeoutSeconds * 1_000_000_000;
        if (lp.failureThreshold) healthcheck.Retries = lp.failureThreshold;
      }
    }

    const hostConfig: Record<string, unknown> = {};
    const networkMode = c?.networkMode
      ?? (c?.providerOverrides as Record<string, unknown> | undefined)?.['networkMode'] as string | undefined;
    if (networkMode) {
      hostConfig.NetworkMode = networkMode;
    }
    if (Object.keys(portBindings).length > 0) hostConfig.PortBindings = portBindings;
    if (c?.resources?.limits) {
      hostConfig.Memory = (c.resources.limits.memory ?? 0) * 1024 * 1024;
      hostConfig.NanoCpus = (c.resources.limits.cpu ?? 0) * 1e9;
    }
    // Volume mounts via Binds (local host paths)
    if (input.volumes?.length && c?.volumeMounts) {
      const binds: string[] = [];
      for (const vm of c.volumeMounts) {
        const vol = input.volumes.find(v => String(v.id) === vm.volumeId);
        const nfsOpts = vol?.options as { path?: string } | undefined;
        const nfsPath = nfsOpts?.path;
        if (nfsPath?.startsWith('/') && isBindMountAllowed(nfsPath)) {
          // Read-only enforced for all bind mounts to prevent host fs tampering
          binds.push(`${nfsPath}:${vm.mountPath}:ro`);
        }
      }
      if (binds.length > 0) hostConfig.Binds = binds;
    }

    const body: Record<string, unknown> = {
      Image: c?.image ?? '',
      Cmd: c?.args ? [...c.args] : undefined,
      Env: env.length ? env : undefined,
      Labels: { 'managed-by': 'hbi-aad', sandbox: input.name },
      ...(Object.keys(exposedPorts).length > 0 ? { ExposedPorts: exposedPorts } : {}),
      ...(healthcheck ? { Healthcheck: healthcheck } : {}),
      ...(Object.keys(hostConfig).length > 0 ? { HostConfig: hostConfig } : {}),
    };

    const nameParam = c?.name ? `?name=${encodeURIComponent(c.name)}` : '';
    const resp = await fetch(`${this.#apiBase}/containers/create${nameParam}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Podman create failed (${resp.status}): ${err}`);
    }
    const data = await resp.json() as { Id: string; Warnings?: string[] };

    // Start the container
    const startResp = await fetch(`${this.#apiBase}/containers/${data.Id}/start`, { method: 'POST' });
    if (!startResp.ok && startResp.status !== 304) {
      // 304 = already started, ignore
      const err = await startResp.text();
      throw new Error(`Podman start failed (${startResp.status}): ${err}`);
    }

    return { providerId: data.Id };
  }

  async describe(input: DescribeContainerGroupsInput): Promise<DescribeContainerGroupsResult> {
    let url = `${this.#apiBase}/containers/json?all=true`;
    if (input.limit) url += `&limit=${input.limit}`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Podman list failed: ${resp.status}`);
    const list = await resp.json() as PodmanContainer[];

    let filtered = list;
    if (input.sandboxName) {
      filtered = filtered.filter(c => c.Names?.some(n => n.includes(input.sandboxName!)));
    }
    if (input.sandboxId) {
      filtered = filtered.filter(c => c.Id.startsWith(input.sandboxId!));
    }
    if (input.status) {
      filtered = filtered.filter(c => podmanStatus(c) === input.status);
    }

    const sandboxes = await Promise.all(
      filtered.map(c => this.#toRuntime(c.Id)),
    );

    return {
      sandboxes: sandboxes.filter((s): s is ContainerGroupRuntime => s !== null),
      totalCount: filtered.length,
    };
  }

  async delete(input: DeleteContainerGroupInput): Promise<void> {
    const resp = await fetch(`${this.#apiBase}/containers/${input.providerId}?force=true`, {
      method: 'DELETE',
    });
    if (!resp.ok && resp.status !== 404) {
      const err = await resp.text();
      throw new Error(`Podman delete failed (${resp.status}): ${err}`);
    }
  }

  async getLogs(input: GetContainerLogInput): Promise<ContainerLogResult> {
    let url = `${this.#apiBase}/containers/${input.providerId}/logs?stdout=true&stderr=true`;
    if (input.limitBytes) url += `&tail=${input.limitBytes}`;
    if (input.sinceSeconds) url += `&since=${Math.floor(Date.now() / 1000) - input.sinceSeconds}`;
    if (input.timestamps) url += `&timestamps=1`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Podman logs failed (${resp.status})`);
    const text = await resp.text();

    return {
      containerName: input.containerName,
      content: text,
    };
  }

  /** Get a single container's full state. */
  async getStatus(providerId: string): Promise<ContainerGroupRuntime | null> {
    return this.#toRuntime(providerId);
  }

  async #toRuntime(containerId: string): Promise<ContainerGroupRuntime | null> {
    const resp = await fetch(`${this.#apiBase}/containers/${containerId}/json`);
    if (resp.status === 404) return null;
    if (!resp.ok) return null;

    const info = await resp.json() as PodmanInspectResult;
    const created = new Date(info.Created).toISOString();

    return {
      providerId: info.Id,
      name: info.Name.replace(/^\//, '') ?? '',
      status: mapPodmanState(info.State.Status),
      regionId: 'local',
      zoneId: undefined,
      creationTime: created,
      expiredTime: undefined,
      instanceType: 'podman',
      spotStrategy: undefined,
      cpu: 0,
      memory: 0,
      network: {
        privateIp: info.NetworkSettings?.IPAddress,
        ...(info.NetworkSettings?.IPAddress ? { privateIp: info.NetworkSettings.IPAddress } : {}),
      } as any,
      associatedResources: [],
      restartPolicy: info.HostConfig?.RestartPolicy?.Name ?? 'OnFailure',
      containers: [{
        id: info.Id as any,
        name: info.Name.replace(/^\//, ''),
        image: info.Config?.Image ?? '',
        args: info.Config?.Cmd ?? [],
        env: parseEnv(info.Config?.Env),
        workingDir: info.Config?.WorkingDir ?? '',
        status: info.State.Status as any,
        alive: info.State.Running,
        createdAt: created,
        startedAt: info.State.StartedAt,
        finishedAt: info.State.FinishedAt,
        exitCode: info.State.ExitCode,
        labels: info.Config?.Labels ?? {},
        annotations: {},
        mounts: (info.Mounts ?? []).map((m: any) => ({
        source: m.Source ?? '',
        destination: m.Destination ?? '',
        type: m.Type,
        options: m.Mode ? [m.Mode] : undefined,
      })),
        health: { status: info.State.Running ? 'healthy' : 'starting' },
      }],
      volumes: [],
      events: [],
      tags: [{ key: 'provider', value: 'podman' }],
    } as any;
  }
}

// ─── Helpers ───

function mapPodmanState(state: string): any {
  switch (state) {
    case 'running': return 'Running';
    case 'paused': return 'Running';
    case 'exited': return 'Succeeded';
    case 'dead': return 'Failed';
    case 'created': return 'Pending';
    default: return 'Pending';
  }
}

function podmanStatus(c: PodmanContainer): string {
  const s = c.State ?? '';
  return mapPodmanState(s);
}

function parseEnv(env?: string[]): Record<string, string> {
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const e of env) {
    const eq = e.indexOf('=');
    if (eq > 0) out[e.slice(0, eq)] = e.slice(eq + 1);
  }
  return out;
}

// ─── Bind mount path validation ───

/** Paths whose direct bind-mount is always denied regardless of intent. */
const SENSITIVE_HOST_PATHS = new Set([
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/sudoers',
  '/etc/sudoers.d',
  '/var/run/docker.sock',
  '/var/run/docker-ce.sock',
  '/run/docker.sock',
  '/run/docker-ce.sock',
]);

/** Path prefixes whose bind-mount is denied (catches sub-paths). */
const SENSITIVE_HOST_PREFIXES = [
  '/proc/',
  '/sys/',
  '/dev/',
  '/boot/',
  '/etc/ssh/',
  '/root/.ssh/',
  '/root/.docker/',
];

/**
 * Validate that a host path is allowed for bind-mount into containers.
 * Blocks well-known sensitive paths that could enable container escape,
 * credential theft, or host filesystem tampering.
 */
function isBindMountAllowed(hostPath: string): boolean {
  if (SENSITIVE_HOST_PATHS.has(hostPath)) return false;
  for (const prefix of SENSITIVE_HOST_PREFIXES) {
    if (hostPath.startsWith(prefix) || hostPath.startsWith(prefix.replace(/\/$/, ''))) return false;
  }
  return true;
}
