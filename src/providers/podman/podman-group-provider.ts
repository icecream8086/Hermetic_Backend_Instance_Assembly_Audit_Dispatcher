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

import { z } from 'zod';
import type {
  IContainerGroupProvider,
  DescribeContainerGroupsInput,
  DescribeContainerGroupsResult,
} from '../../core/provider/interfaces.ts';
import type { ContainerGroupRuntime, OciContainerStatus } from '../../core/provider/types.ts';
import { createContainerId } from '../../core/provider/types.ts';
import { createRegionId } from '../../core/region/types.ts';
import { ContainerGroupState } from '../../core/provider/container-lifecycle.ts';
import { PodmanPodCodec } from './pod-codec.ts';
import type { PodmanCreateRequest } from './pod-codec.ts';
import type { PodSpec } from '../../core/pod/types.ts';

// ─── Zod schemas (CEA: no `as` on API responses) ───

const podCreateResultSchema = z.object({
  Id: z.string(),
  Name: z.string(),
});

const podInspectResultSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  State: z.string(),
  Containers: z.array(z.object({
    Id: z.string(),
    Name: z.string(),
    State: z.string(),
  })),
  Labels: z.record(z.string(), z.string()).optional(),
  Created: z.string().optional(),
});

const containerInspectResultSchema = z.object({
  Id: z.string().optional(),
  Name: z.string().optional(),
  State: z.object({
    Status: z.string().optional(),
    Running: z.boolean().optional(),
    StartedAt: z.string().optional(),
    FinishedAt: z.string().optional(),
    ExitCode: z.number().optional(),
  }).optional(),
  Config: z.object({
    Image: z.string().optional(),
    Cmd: z.array(z.string()).optional(),
    Env: z.array(z.string()).optional(),
    WorkingDir: z.string().optional(),
    Labels: z.record(z.string(), z.string()).optional(),
  }).optional(),
  HostConfig: z.object({
    NanoCpus: z.number().optional(),
    Memory: z.number().optional(),
    CpuShares: z.number().optional(),
  }).optional(),
  Mounts: z.array(z.object({
    Source: z.string().optional(),
    Destination: z.string().optional(),
    Type: z.string().optional(),
    Mode: z.string().optional(),
  })).optional(),
  NetworkSettings: z.object({
    IPAddress: z.string().optional(),
  }).optional(),
  Created: z.string().optional(),
});

const podListSchema = z.array(z.object({
  Id: z.string(),
  Name: z.string(),
  Status: z.string(),
  Labels: z.record(z.string(), z.string()).optional(),
  Created: z.string().optional(),
}));

type PodmanPodInspectResult = z.infer<typeof podInspectResultSchema>;
type PodmanPodListItem = z.infer<typeof podListSchema>[number];
type ContainerInspectResult = z.infer<typeof containerInspectResultSchema>;

// ─── Provider ───

export class PodmanContainerGroupProvider implements IContainerGroupProvider {
  readonly #dockerApi: string;   // Docker-compatible v1.24 (for per-container inspect)
  readonly #libpodApi: string;   // Libpod v5 (for pod operations)
  readonly #codec: PodmanPodCodec;
  /** Tracks terminationGracePeriodSeconds by pod providerId for stop operations. */
  readonly #terminationGracePeriodByPodId = new Map<string, number>();

  public constructor(endpoint = 'http://127.0.0.1:8080') {
    this.#dockerApi = `${endpoint}/v1.24`;
    this.#libpodApi = `${endpoint}/v5.0.0/libpod`;
    this.#codec = new PodmanPodCodec();
  }

  // ─── IContainerGroupProvider ───

  public async createPod(spec: PodSpec): Promise<{ providerId: string }> {
    const request = this.#codec.encode(spec);
    return this.#createFromRequest(request);
  }

  public async stopGroup(providerId: string): Promise<void> {
    const timeout = this.#terminationGracePeriodByPodId.get(providerId);
    let url = `${this.#libpodApi}/pods/${encodeURIComponent(providerId)}/stop`;
    if (timeout !== undefined) url += `?t=${String(timeout)}`;
    const resp = await fetch(url, { method: 'POST' });
    if (!resp.ok && resp.status !== 304) {
      const err = await resp.text();
      throw new Error(`Podman pod stop failed (${String(resp.status)}): ${err}`);
    }
  }

  public async deleteGroup(providerId: string): Promise<void> {
    this.#terminationGracePeriodByPodId.delete(providerId);
    await this.#forceDeletePod(providerId);
  }

  public async getGroupStatus(providerId: string): Promise<ContainerGroupRuntime | null> {
    return this.#inspectPod(providerId);
  }

  public async describeGroups(input: DescribeContainerGroupsInput): Promise<DescribeContainerGroupsResult> {
    const pods = await this.#listPods();
    const nameFilter = input.sandboxName;
    const idFilter = input.sandboxId;

    const filtered = pods.filter((p: PodmanPodListItem) => {
      if (nameFilter !== undefined && !p.Name.includes(nameFilter)) return false;
      if (idFilter !== undefined && !p.Id.startsWith(idFilter)) return false;
      return true;
    });

    const limited = input.limit !== undefined ? filtered.slice(0, input.limit) : filtered;

    const sandboxes = await Promise.all(
      limited.map(p => this.#podToRuntime(p)),
    );

    return {
      sandboxes: sandboxes.filter((s): s is ContainerGroupRuntime => s !== null),
      totalCount: pods.length,
    };
  }

  // ─── Private: create orchestration ───

  async #createFromRequest(request: PodmanCreateRequest): Promise<{ providerId: string }> {
    const portMappings = request.pod.publish ?? [];
    const networkName = request.pod.networks?.[0]?.name;

    const body: Record<string, unknown> = {
      name: request.pod.name,
      labels: request.pod.labels,
      share: request.pod.share ?? ['net', 'uts', 'ipc'],
      infra: request.pod.infra ?? true,
    };
    if (portMappings.length > 0) body.port_mappings = portMappings.map(p => ({
      container_port: p.containerPort,
      ...(p.hostPort !== undefined ? { host_port: p.hostPort } : {}),
      ...(p.protocol !== undefined ? { protocol: p.protocol } : {}),
    }));
    if (networkName) {
      body.networks = [{ name: networkName }];
    }
    // ── Scheduling fields ──
    if (request.pod.dnsServers?.length) body.dns_server = [...request.pod.dnsServers];
    if (request.pod.dnsSearches?.length) body.dns_search = [...request.pod.dnsSearches];
    if (request.pod.dnsOptions?.length) body.dns_option = [...request.pod.dnsOptions];
    if (request.pod.addHosts?.length) body.add_hosts = [...request.pod.addHosts];

    const podResp = await fetch(`${this.#libpodApi}/pods/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!podResp.ok) {
      const err = await podResp.text();
      throw new Error(`Podman pod create failed (${String(podResp.status)}): ${err}`);
    }
    const pod = podCreateResultSchema.parse(await podResp.json());

    // Store terminationGracePeriodSeconds for stopGroup() timeout
    if (request.pod.terminationGracePeriodSeconds !== undefined) {
      this.#terminationGracePeriodByPodId.set(pod.Id, request.pod.terminationGracePeriodSeconds);
    }

    for (const c of request.containers) {
      const containerResp = await fetch(
        `${this.#libpodApi}/containers/create?pod=${encodeURIComponent(pod.Name)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(c),
        },
      );
      if (!containerResp.ok) {
        const err = await containerResp.text();
        await this.#forceDeletePod(pod.Name);
        throw new Error(`Podman container create in pod failed (${String(containerResp.status)}): ${err}`);
      }
    }

    const startResp = await fetch(`${this.#libpodApi}/pods/${encodeURIComponent(pod.Name)}/start`, {
      method: 'POST',
    });
    if (!startResp.ok) {
      const err = await startResp.text();
      await this.#forceDeletePod(pod.Name);
      throw new Error(`Podman pod start failed (${String(startResp.status)}): ${err}`);
    }

    return { providerId: pod.Id };
  }

  // ─── Private: inspect / describe ───

  async #inspectPod(idOrName: string): Promise<ContainerGroupRuntime | null> {
    const resp = await fetch(`${this.#libpodApi}/pods/${encodeURIComponent(idOrName)}/json`);
    if (resp.status === 404) return null;
    if (!resp.ok) return null;
    const raw = await resp.json();
    const info = podInspectResultSchema.parse(raw);
    return this.#podToRuntime(info);
  }

  async #podToRuntime(
    pod: PodmanPodInspectResult | PodmanPodListItem,
  ): Promise<ContainerGroupRuntime | null> {
    let detail: PodmanPodInspectResult;
    // PodmanPodInspectResult has 'State', PodmanPodListItem has 'Status' — discriminate by field
    if (pod.State != null) {
      detail = pod;
    } else {
      const resp = await fetch(`${this.#libpodApi}/pods/${encodeURIComponent(pod.Id)}/json`);
      if (!resp.ok) return null;
      detail = podInspectResultSchema.parse(await resp.json());
    }

    const containerDetails = await Promise.all(
      detail.Containers.map(async (pc) => {
        const cResp = await fetch(`${this.#dockerApi}/containers/${pc.Id}/json`);
        if (!cResp.ok) return null;
        return containerInspectResultSchema.parse(await cResp.json());
      }),
    );

    const containers = containerDetails
      .filter((c): c is ContainerInspectResult => c !== null)
      .map(c => ({
        id: createContainerId(c.Id ?? 'unknown'),
        name: (c.Name ?? '').replace(/^\//, ''),
        image: c.Config?.Image ?? '',
        args: c.Config?.Cmd ?? [],
        env: parseEnv(c.Config?.Env),
        workingDir: c.Config?.WorkingDir ?? '',
        status: podmanToOciStatus(c.State?.Status),
        alive: c.State?.Running ?? false,
        createdAt: c.Created ?? '',
        startedAt: c.State?.StartedAt,
        finishedAt: c.State?.FinishedAt,
        exitCode: c.State?.ExitCode,
        labels: c.Config?.Labels ?? {},
        annotations: {},
        mounts: (c.Mounts ?? []).map(m => ({
          source: m.Source ?? '',
          destination: m.Destination ?? '',
          type: m.Type ?? undefined,
          options: m.Mode ? [m.Mode] : undefined,
        })),
        health: { status: buildHealthStatus(c.State?.Running ?? false) },
      }));

    // Recalculate resources from validated container data
    let cpuTotal = 0;
    let memTotal = 0;
    for (const ci of containerDetails) {
      if (ci === null) continue;
      const hc = ci.HostConfig;
      if (hc?.NanoCpus !== undefined) cpuTotal += hc.NanoCpus / 1e9;
      else if (hc?.CpuShares !== undefined) cpuTotal += hc.CpuShares / 1024;
      if (hc?.Memory !== undefined) memTotal += Math.round(hc.Memory / 1024 / 1024);
    }

    return {
      providerId: detail.Id,
      name: detail.Name,
      status: mapPodmanPodState(detail.State),
      regionId: createRegionId('local'),
      creationTime: detail.Created ?? '',
      instanceType: 'podman-pod',
      cpu: cpuTotal || 0,
      memory: memTotal || 0,
      network: {},
      associatedResources: [],
      restartPolicy: 'OnFailure',
      containers,
      volumes: [],
      events: [],
      tags: [{ key: 'provider', value: 'podman' }, { key: 'type', value: 'pod' }],
    };
  }

  async #listPods(): Promise<PodmanPodListItem[]> {
    const resp = await fetch(`${this.#libpodApi}/pods/json`);
    if (!resp.ok) return [];
    const raw = await resp.json();
    return podListSchema.parse(raw);
  }

  async #forceDeletePod(idOrName: string): Promise<void> {
    const resp = await fetch(`${this.#libpodApi}/pods/${encodeURIComponent(idOrName)}?force=true`, {
      method: 'DELETE',
    });
    if (!resp.ok && resp.status !== 404) {
      const err = await resp.text();
      throw new Error(`Podman pod delete failed (${String(resp.status)}): ${err}`);
    }
  }
}

// ─── Helpers ───

function buildHealthStatus(running: boolean): 'healthy' | 'starting' {
  return running ? 'healthy' : 'starting';
}

function podmanToOciStatus(status: string | undefined): OciContainerStatus {
  switch (status) {
    case 'running': return 'running';
    case 'paused': return 'paused';
    case 'exited':
    case 'dead': return 'stopped';
    case 'created': return 'created';
    case undefined: return 'creating';
    default: return 'creating';
  }
}

function mapPodmanPodState(state: string): ContainerGroupState {
  switch (state) {
    case 'Running':
    case 'Running (all containers)':
    case 'Degraded':
      return ContainerGroupState.Running;
    case 'Stopped':
      return ContainerGroupState.Stopped;
    case 'Paused':
      return ContainerGroupState.Paused;
    case 'Exited':
      return ContainerGroupState.Failed;
    default:
      return ContainerGroupState.Pending;
  }
}

function parseEnv(env?: string[]): Record<string, string> {
  if (!env?.length) return {};
  const out: Record<string, string> = {};
  for (const e of env) {
    const eq = e.indexOf('=');
    if (eq > 0) out[e.slice(0, eq)] = e.slice(eq + 1);
    else out[e] = '';
  }
  return out;
}

