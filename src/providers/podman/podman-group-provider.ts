/**
 * Podman container group provider — implements IContainerGroupProvider via
 * Podman's libpod pods API (v5).
 *
 * A "container group" maps to a Podman pod: one infra container holds shared
 * kernel namespaces (net/uts/ipc), and service containers join the pod.
 * All containers are created before the pod is started.
 *
 * This is the pod-level abstraction; for single-container operations see
 * PodmanContainerProvider (podman-provider.ts).
 *
 * Endpoint defaults to http://127.0.0.1:8080 (podman's default API port).
 */

import type {
  IContainerGroupProvider,
  DescribeContainerGroupsInput,
  DescribeContainerGroupsResult,
  CreateContainerGroupInput,
  ContainerGroupRuntime,
} from '../../core/provider/index.ts';

// ─── Podman API response types ───

interface PodmanInspectResult {
  Id: string;
  Name: string;
  State: {
    Status: string;
    Running: boolean;
    StartedAt?: string;
    FinishedAt?: string;
    ExitCode?: number;
  };
  Config: {
    Image: string;
    Cmd?: string[];
    Env?: string[];
    WorkingDir?: string;
    Labels?: Record<string, string>;
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

interface PodmanPodCreateResult {
  Id: string;
  Name: string;
}

interface PodmanPodInspectContainer {
  Id: string;
  Name: string;
  State: string;
}

interface PodmanPodInspectResult {
  Id: string;
  Name: string;
  State: string;
  Containers: PodmanPodInspectContainer[];
  Labels?: Record<string, string>;
  Created: string;
}

interface PodmanPodListItem {
  Id: string;
  Name: string;
  Status: string;
  Labels?: Record<string, string>;
  Created: string;
}

// ─── Provider ───

export class PodmanContainerGroupProvider implements IContainerGroupProvider {
  readonly #dockerApi: string;   // Docker-compatible v1.24 (for per-container inspect)
  readonly #libpodApi: string;   // Libpod v5 (for pod operations)

  constructor(endpoint = 'http://127.0.0.1:8080') {
    this.#dockerApi = `${endpoint}/v1.24`;
    this.#libpodApi = `${endpoint}/v5.0.0/libpod`;
  }

  // ─── IContainerGroupProvider ───

  async createGroup(input: CreateContainerGroupInput): Promise<{ providerId: string }> {
    const podName = input.name;
    const portMappings = this.#collectPortMappings(input);

    // Apply network from providerOverrides (set by network policy layer)
    const overrides = input.providerOverrides as Record<string, unknown> | undefined;
    const networkName = overrides?.['network'] as string | undefined;

    // 1. Create pod
    const podSpec: Record<string, unknown> = {
      name: podName,
      labels: { 'managed-by': 'hbi-aad', group: input.name },
      share: ['net', 'uts', 'ipc'],
      infra: true,
    };
    if (portMappings.length > 0) podSpec.port_mappings = portMappings;
    if (networkName) {
      podSpec.networks = [{ name: networkName }];
    }

    const podResp = await fetch(`${this.#libpodApi}/pods/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(podSpec),
    });
    if (!podResp.ok) {
      const err = await podResp.text();
      throw new Error(`Podman pod create failed (${podResp.status}): ${err}`);
    }
    const pod = await podResp.json() as PodmanPodCreateResult;

    // 2. Create each container in the pod
    for (const c of input.containers) {
      const env: string[] = [];
      if (c.env) {
        for (const e of c.env) {
          if (e.value !== undefined) env.push(`${e.name}=${e.value}`);
        }
      }

      const body: Record<string, unknown> = {
        name: c.name,
        Image: c.image ?? '',
        Cmd: c.args ? [...c.args] : undefined,
        Env: env.length ? env : undefined,
        Labels: { 'managed-by': 'hbi-aad', service: c.name },
      };

      // Health check
      const hc = this.#buildHealthcheck(c.livenessProbe as Record<string, unknown> | undefined);
      if (hc) body.Healthcheck = hc;

      const containerResp = await fetch(
        `${this.#libpodApi}/containers/create?pod=${encodeURIComponent(pod.Name)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!containerResp.ok) {
        const err = await containerResp.text();
        await this.#forceDeletePod(pod.Name);
        throw new Error(`Podman container create in pod failed (${containerResp.status}): ${err}`);
      }
    }

    // 3. Start the pod (starts all containers)
    const startResp = await fetch(`${this.#libpodApi}/pods/${encodeURIComponent(pod.Name)}/start`, {
      method: 'POST',
    });
    if (!startResp.ok) {
      const err = await startResp.text();
      await this.#forceDeletePod(pod.Name);
      throw new Error(`Podman pod start failed (${startResp.status}): ${err}`);
    }

    return { providerId: pod.Id };
  }

  async deleteGroup(providerId: string): Promise<void> {
    await this.#forceDeletePod(providerId);
  }

  async getGroupStatus(providerId: string): Promise<ContainerGroupRuntime | null> {
    return this.#inspectPod(providerId);
  }

  async describeGroups(input: DescribeContainerGroupsInput): Promise<DescribeContainerGroupsResult> {
    const pods = await this.#listPods();
    let filtered = pods;

    if (input.sandboxName) {
      filtered = filtered.filter(p => p.Name.includes(input.sandboxName!));
    }
    if (input.sandboxId) {
      filtered = filtered.filter(p => p.Id.startsWith(input.sandboxId!));
    }
    if (input.limit) {
      filtered = filtered.slice(0, input.limit);
    }

    const sandboxes = await Promise.all(
      filtered.map(p => this.#podToRuntime(p)),
    );

    return {
      sandboxes: sandboxes.filter((s): s is ContainerGroupRuntime => s !== null),
      totalCount: filtered.length,
    };
  }

  // ─── Private ───

  #collectPortMappings(input: CreateContainerGroupInput): Record<string, unknown>[] {
    const mappings: Record<string, unknown>[] = [];
    for (const c of input.containers) {
      if (c.ports) {
        for (const p of c.ports) {
          const entry: Record<string, unknown> = { container_port: p.containerPort };
          if (p.hostPort !== undefined) entry.host_port = p.hostPort;
          if (p.protocol !== undefined) entry.protocol = p.protocol;
          mappings.push(entry);
        }
      }
    }
    return mappings;
  }

  #buildHealthcheck(lp: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!lp) return undefined;
    const exec = lp['exec'] as { command?: string[] } | undefined;
    const httpGet = lp['httpGet'] as { port?: number; path?: string } | undefined;
    const tcpSocket = lp['tcpSocket'] as { port?: number } | undefined;

    let hc: Record<string, unknown> | undefined;
    if (exec?.command) {
      hc = { Test: ['CMD', ...exec.command] };
    } else if (httpGet?.port) {
      hc = { Test: ['CMD', 'curl', '-sf', `http://localhost:${httpGet.port}${httpGet.path ?? '/'}`] };
    } else if (tcpSocket?.port) {
      hc = { Test: ['CMD-SHELL', `exec 3<>/dev/tcp/localhost/${tcpSocket.port}`] };
    }
    if (hc) {
      if (lp['initialDelaySeconds']) hc.StartPeriod = (lp['initialDelaySeconds'] as number) * 1_000_000_000;
      if (lp['periodSeconds']) hc.Interval = (lp['periodSeconds'] as number) * 1_000_000_000;
      if (lp['timeoutSeconds']) hc.Timeout = (lp['timeoutSeconds'] as number) * 1_000_000_000;
      if (lp['failureThreshold']) hc.Retries = lp['failureThreshold'];
    }
    return hc;
  }

  async #inspectPod(idOrName: string): Promise<ContainerGroupRuntime | null> {
    const resp = await fetch(`${this.#libpodApi}/pods/${encodeURIComponent(idOrName)}/json`);
    if (resp.status === 404) return null;
    if (!resp.ok) return null;
    const info = await resp.json() as PodmanPodInspectResult;
    return this.#podToRuntime(info);
  }

  async #podToRuntime(
    pod: PodmanPodInspectResult | PodmanPodListItem,
  ): Promise<ContainerGroupRuntime | null> {
    let detail: PodmanPodInspectResult;
    if ('Containers' in pod && Array.isArray((pod as any).Containers)) {
      detail = pod as PodmanPodInspectResult;
    } else {
      const resp = await fetch(`${this.#libpodApi}/pods/${encodeURIComponent(pod.Id)}/json`);
      if (!resp.ok) return null;
      detail = await resp.json() as PodmanPodInspectResult;
    }

    const containerDetails = await Promise.all(
      detail.Containers.map(async (pc) => {
        const cResp = await fetch(`${this.#dockerApi}/containers/${pc.Id}/json`);
        if (!cResp.ok) return null;
        return cResp.json() as Promise<PodmanInspectResult>;
      }),
    );

    const containers = containerDetails
      .filter((c): c is PodmanInspectResult => c !== null)
      .map(c => ({
        id: c.Id as any,
        name: c.Name.replace(/^\//, ''),
        image: c.Config?.Image ?? '',
        args: c.Config?.Cmd ?? [],
        env: parseEnv(c.Config?.Env),
        workingDir: c.Config?.WorkingDir ?? '',
        status: c.State.Status as any,
        alive: c.State.Running,
        createdAt: c.Created,
        startedAt: c.State.StartedAt,
        finishedAt: c.State.FinishedAt,
        exitCode: c.State.ExitCode,
        labels: c.Config?.Labels ?? {},
        annotations: {},
        mounts: (c.Mounts ?? []).map((m: any) => ({
          source: m.Source ?? '',
          destination: m.Destination ?? '',
          type: m.Type,
          options: m.Mode ? [m.Mode] : undefined,
        })),
        health: { status: c.State.Running ? 'healthy' : 'starting' },
      }));

    return {
      providerId: detail.Id,
      name: detail.Name,
      status: mapPodmanPodState(detail.State),
      regionId: 'local',
      zoneId: undefined,
      creationTime: detail.Created,
      expiredTime: undefined,
      instanceType: 'podman-pod',
      spotStrategy: undefined,
      cpu: 0,
      memory: 0,
      network: {},
      associatedResources: [],
      restartPolicy: 'OnFailure',
      containers: containers as any,
      volumes: [],
      events: [],
      tags: [{ key: 'provider', value: 'podman' }, { key: 'type', value: 'pod' }],
    } as any;
  }

  async #listPods(): Promise<PodmanPodListItem[]> {
    const resp = await fetch(`${this.#libpodApi}/pods/json`);
    if (!resp.ok) return [];
    return resp.json() as Promise<PodmanPodListItem[]>;
  }

  async #forceDeletePod(idOrName: string): Promise<void> {
    const resp = await fetch(`${this.#libpodApi}/pods/${encodeURIComponent(idOrName)}?force=true`, {
      method: 'DELETE',
    });
    if (!resp.ok && resp.status !== 404) {
      const err = await resp.text();
      throw new Error(`Podman pod delete failed (${resp.status}): ${err}`);
    }
  }
}

// ─── Helpers ───

function mapPodmanPodState(state: string): any {
  switch (state) {
    case 'Running':
    case 'Running (all containers)':
    case 'Degraded':
      return 'Running';
    default: return 'Pending';
  }
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
