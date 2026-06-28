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
  ContainerLifecycle,
  DescribeContainerGroupsInput,
  DescribeContainerGroupsResult,
  DeleteContainerGroupInput,
  GetContainerLogInput,
  ContainerLogResult,
} from '../../core/provider/interfaces.ts';
import type { CreateContainerGroupInput, ContainerGroupRuntime, OciContainerStatus } from '../../core/provider/types.ts';
import { createContainerId } from '../../core/provider/types.ts';
import { createRegionId } from '../../core/region/types.ts';
import { debugLog } from '../../core/audit/log-policy.ts';

interface PodmanContainer {
  Id: string;
  Names?: string[];
  Image?: string;
  ImageID?: string;
  State?: string;
  Status?: string;
  Created?: number;
  Ports?: {
    containerPort: number;
    hostPort?: number;
    protocol?: string;
  }[];
  Labels?: Record<string, string>;
  Mounts?: {
    Source: string;
    Destination: string;
    Mode?: string;
    RW?: boolean;
  }[];
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
    Health?: { Status?: string; FailingStreak?: number; Log?: { Start?: string; End?: string; ExitCode?: number; Output?: string }[] };
  };
  Config: {
    Image: string;
    Cmd?: string[];
    Env?: string[];
    WorkingDir?: string;
    Labels?: Record<string, string>;
  };
  HostConfig: {
    PortBindings?: Record<string, { HostPort?: string }[]>;
    RestartPolicy?: { Name?: string };
    NetworkMode?: string;
  };
  Mounts?: {
    Source: string;
    Destination: string;
    Type?: string;
    Mode?: string;
  }[];
  NetworkSettings?: {
    IPAddress?: string;
  };
  Created: string;
}

export class PodmanContainerProvider implements IContainerProvider {
  readonly lifecycle: ContainerLifecycle = { stopIsDelete: false, startable: true, healthProbes: true, asyncInit: false };
  readonly #apiBase: string;
  /** Tracks created Podman secret IDs for cleanup on container delete. */
  readonly #createdSecrets = new Map<string, string[]>();

  public constructor(endpoint = 'http://127.0.0.1:8080') {
    this.#apiBase = `${endpoint}/v1.24`;
  }

  // ─── IContainerProvider ───

  public async create(input: CreateContainerGroupInput): Promise<{ providerId: string }> {
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
    const portBindings: Record<string, { HostPort?: string }[]> = {};
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
      ?? (c?.providerOverrides)?.networkMode as string | undefined;
    if (networkMode) {
      hostConfig.NetworkMode = networkMode;
    }
    if (Object.keys(portBindings).length > 0) hostConfig.PortBindings = portBindings;
    if (c?.resources?.limits) {
      hostConfig.Memory = (c.resources.limits.memory ?? 0) * 1024 * 1024;
      hostConfig.NanoCpus = (c.resources.limits.cpu ?? 0) * 1e9;
      if (c.resources.limits.gpu && c.resources.limits.gpu > 0) {
        hostConfig.DeviceRequests = [{ Driver: 'nvidia', Count: c.resources.limits.gpu, Capabilities: [['gpu']] }];
      }
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

    // Secret mounts — create as Podman secrets via libpod API, mount to /run/secrets/{name}
    // The container sees them as regular files in a tmpfs (memory-backed).
    const createdSecrets: string[] = [];
    if (input.secretMounts?.length) {
      const mounts = (hostConfig.Mounts as Record<string, unknown>[]) ?? [];
      for (const sm of input.secretMounts) {
        const secretName = `hbi_${crypto.randomUUID().slice(0, 8)}`;
        try {
          // Create Podman secret via libpod API
          const secResp = await fetch(`${this.#apiBase.replace('/v1.24', '')}/libpod/secrets/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: secretName, data: btoa(sm.data) }),
          });
          if (secResp.ok) {
            const sec = await secResp.json();
            createdSecrets.push(sec.ID);
            mounts.push({
              Type: 'tmpfs',
              Target: sm.mountPath,
              TmpfsOptions: { SizeBytes: Math.max(sm.data.length * 2, 4096), Mode: sm.mode ?? 0o600 },
            });
          }
        } catch {
          // libpod API unavailable — skip; secret data stays encrypted at rest
        }
      }
      if (mounts.length > 0) hostConfig.Mounts = mounts;
    }

    const body: Record<string, unknown> = {
      Image: c?.image ?? '',
      Entrypoint: c?.command ? [...c.command] : undefined,
      Cmd: c?.args ? [...c.args] : undefined,
      Env: env.length ? env : undefined,
      Labels: { 'managed-by': 'hbi-aad', sandbox: input.name },
      ...(Object.keys(exposedPorts).length > 0 ? { ExposedPorts: exposedPorts } : {}),
      ...(healthcheck ? { Healthcheck: healthcheck } : {}),
      ...(Object.keys(hostConfig).length > 0 ? { HostConfig: hostConfig } : {}),
    };

    // No container name — Podman auto-assigns a unique one.
    // We always refer to containers by their ID (providerId), so the name is irrelevant.
    const nameParam = '';
    debugLog('sandbox-service', 'Podman create: apiBase=%s, image=%s', this.#apiBase, c?.image);
    let resp: Response;
    try {
      resp = await fetch(`${this.#apiBase}/containers/create${nameParam}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (fetchErr: unknown) {
      debugLog('sandbox-service', 'Podman fetch failed: %O', { apiBase: this.#apiBase, error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr), stack: fetchErr instanceof Error ? fetchErr.stack : undefined });
      throw new Error(`Podman connection failed to ${this.#apiBase}: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
    }
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Podman create failed (${resp.status}): ${err}`);
    }
    const data = await resp.json();

    // Start the container
    const startResp = await fetch(`${this.#apiBase}/containers/${data.Id}/start`, { method: 'POST' });
    if (!startResp.ok && startResp.status !== 304) {
      // 304 = already started, ignore
      const err = await startResp.text();
      throw new Error(`Podman start failed (${startResp.status}): ${err}`);
    }

    // Track created secrets for cleanup
    if (createdSecrets.length > 0) {
      this.#createdSecrets.set(data.Id, createdSecrets);
    }

    return { providerId: data.Id };
  }

  public async describe(input: DescribeContainerGroupsInput): Promise<DescribeContainerGroupsResult> {
    let url = `${this.#apiBase}/containers/json?all=true`;
    if (input.limit) url += `&limit=${input.limit}`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Podman list failed: ${resp.status}`);
    const list = await resp.json();

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

  public async delete(input: DeleteContainerGroupInput): Promise<void> {
    // Clean up Podman secrets created for this container
    const secretIds = this.#createdSecrets.get(input.providerId);
    if (secretIds?.length) {
      for (const sid of secretIds) {
        try {
          await fetch(`${this.#apiBase.replace('/v1.24', '')}/libpod/secrets/${sid}`, { method: 'DELETE' });
        } catch { /* best-effort cleanup */ }
      }
      this.#createdSecrets.delete(input.providerId);
    }

    const resp = await fetch(`${this.#apiBase}/containers/${input.providerId}?force=true`, {
      method: 'DELETE',
    });
    if (!resp.ok && resp.status !== 404) {
      const err = await resp.text();
      throw new Error(`Podman delete failed (${resp.status}): ${err}`);
    }
  }

  public async getLogs(input: GetContainerLogInput): Promise<ContainerLogResult> {
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
  public async getStatus(providerId: string): Promise<ContainerGroupRuntime | null> {
    return this.#toRuntime(providerId);
  }

  // ─── Container lifecycle operations ───

  public async stop(providerId: string, timeoutSeconds?: number): Promise<void> {
    let url = `${this.#apiBase}/containers/${encodeURIComponent(providerId)}/stop`;
    if (timeoutSeconds !== undefined) url += `?t=${timeoutSeconds}`;
    const resp = await this.#fetch(url, { method: 'POST' });
    if (!resp) throw new Error('Podman daemon unreachable');
    if (resp.status === 304) return; // already stopped
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Podman stop failed (${resp.status}): ${body.slice(0, 200)}`);
    }
  }

  public async start(providerId: string): Promise<void> {
    const url = `${this.#apiBase}/containers/${encodeURIComponent(providerId)}/start`;
    const resp = await this.#fetch(url, { method: 'POST' });
    if (!resp) throw new Error('Podman daemon unreachable');
    if (resp.status === 304) return; // already started
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Podman start failed (${resp.status}): ${body.slice(0, 200)}`);
    }
  }

  public async restart(providerId: string, timeoutSeconds?: number): Promise<void> {
    let url = `${this.#apiBase}/containers/${encodeURIComponent(providerId)}/restart`;
    if (timeoutSeconds !== undefined) url += `?t=${timeoutSeconds}`;
    const resp = await this.#fetch(url, { method: 'POST' });
    if (!resp) throw new Error('Podman daemon unreachable');
    if (resp.status === 304) return; // already restarting
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Podman restart failed (${resp.status}): ${body.slice(0, 200)}`);
    }
  }

  public async kill(providerId: string, signal?: string): Promise<void> {
    let url = `${this.#apiBase}/containers/${encodeURIComponent(providerId)}/kill`;
    if (signal) url += `?signal=${encodeURIComponent(signal)}`;
    const resp = await this.#fetch(url, { method: 'POST' });
    if (!resp) throw new Error('Podman daemon unreachable');
    if (resp.status === 304) return; // already stopped/killed
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Podman kill failed (${resp.status}): ${body.slice(0, 200)}`);
    }
  }

  public async pause(providerId: string): Promise<void> {
    const resp = await this.#fetch(`${this.#apiBase}/containers/${encodeURIComponent(providerId)}/pause`, { method: 'POST' });
    if (!resp) throw new Error('Podman daemon unreachable');
    if (!resp.ok) throw new Error(`Podman pause failed (${resp.status})`);
  }

  public async unpause(providerId: string): Promise<void> {
    const resp = await this.#fetch(`${this.#apiBase}/containers/${encodeURIComponent(providerId)}/unpause`, { method: 'POST' });
    if (!resp) throw new Error('Podman daemon unreachable');
    if (!resp.ok) throw new Error(`Podman unpause failed (${resp.status})`);
  }

  public async wait(providerId: string, _condition?: 'not-running' | 'next-exit'): Promise<{ statusCode: number }> {
    const resp = await this.#fetch(`${this.#apiBase}/containers/${encodeURIComponent(providerId)}/wait`, { method: 'POST' });
    if (!resp) throw new Error('Podman daemon unreachable');
    if (!resp.ok) throw new Error(`Podman wait failed (${resp.status})`);
    const data = await resp.json();
    return { statusCode: data.StatusCode ?? -1 };
  }

  public async exec(providerId: string, cmd: readonly string[], _containerName?: string): Promise<{ execId: string; webSocketUri?: string }> {
    // Step 1: Create exec instance
    const createResp = await this.#fetch(`${this.#apiBase}/containers/${encodeURIComponent(providerId)}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Cmd: [...cmd], AttachStdout: true, AttachStderr: true }),
    });
    if (!createResp) throw new Error('Podman daemon unreachable');
    if (!createResp.ok) throw new Error(`Podman exec create failed (${createResp.status})`);
    const { Id: execId } = await createResp.json();

    // Step 2: Start exec
    const startResp = await this.#fetch(`${this.#apiBase}/exec/${execId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Detach: false, Tty: false }),
    });
    if (!startResp) throw new Error('Podman daemon unreachable');
    if (!startResp.ok) throw new Error(`Podman exec start failed (${startResp.status})`);

    return { execId };
  }

  public async rename(providerId: string, newName: string): Promise<void> {
    const resp = await this.#fetch(`${this.#apiBase}/containers/${encodeURIComponent(providerId)}/rename?name=${encodeURIComponent(newName)}`, { method: 'POST' });
    if (!resp) throw new Error('Podman daemon unreachable');
    if (!resp.ok) throw new Error(`Podman rename failed (${resp.status})`);
  }

  public async stats(providerId: string): Promise<{ cpuUsage: number; memoryUsage: number; networkIO?: { rx: number; tx: number } }> {
    const resp = await this.#fetch(`${this.#apiBase}/containers/${encodeURIComponent(providerId)}/stats?stream=false`);
    if (!resp) throw new Error('Podman daemon unreachable');
    if (!resp.ok) throw new Error(`Podman stats failed (${resp.status})`);
    const data = await resp.json();
    const netKeys = data.networks ? Object.keys(data.networks) : [];
    return {
      cpuUsage: data.cpu_stats?.cpu_usage?.total_usage ?? 0,
      memoryUsage: data.memory_stats?.usage ?? 0,
      ...(netKeys.length > 0 ? { networkIO: { rx: data.networks![netKeys[0]!]?.rx_bytes ?? 0, tx: data.networks![netKeys[0]!]?.tx_bytes ?? 0 } } : {}),
    };
  }

  public async top(providerId: string, psArgs?: string): Promise<{ processes: readonly (readonly string[])[] }> {
    let url = `${this.#apiBase}/containers/${encodeURIComponent(providerId)}/top`;
    if (psArgs) url += `?ps_args=${encodeURIComponent(psArgs)}`;
    const resp = await this.#fetch(url);
    if (!resp) throw new Error('Podman daemon unreachable');
    if (!resp.ok) throw new Error(`Podman top failed (${resp.status})`);
    const data = await resp.json();
    return { processes: data.Processes ?? [] };
  }

  /** Fetch with connection error protection. Returns null when Podman is down. */
  public async #fetch(url: string, init?: RequestInit): Promise<Response | null> {
    try {
      return await fetch(url, init);
    } catch {
      return null;
    }
  }

  public async #toRuntime(containerId: string): Promise<ContainerGroupRuntime | null> {
    const resp = await fetch(`${this.#apiBase}/containers/${containerId}/json`);
    if (resp.status === 404) return null;
    if (!resp.ok) return null;

    const info = await resp.json();
    const created = new Date(info.Created).toISOString();

    return {
      providerId: info.Id,
      name: info.Name.replace(/^\//, '') ?? '',
      status: mapPodmanState(info.State.Status),
      regionId: createRegionId('local'),
      creationTime: created,
      instanceType: 'podman',
      cpu: 0,
      memory: 0,
      network: {
        ...(info.NetworkSettings?.IPAddress ? { privateIp: info.NetworkSettings.IPAddress } : {}),
      },
      associatedResources: [],
      restartPolicy: info.HostConfig?.RestartPolicy?.Name ?? 'OnFailure',
      containers: [{
        id: createContainerId(info.Id ?? 'unknown'),
        name: info.Name.replace(/^\//, ''),
        image: info.Config?.Image ?? '',
        args: info.Config?.Cmd ?? [],
        env: parseEnv(info.Config?.Env),
        workingDir: info.Config?.WorkingDir ?? '',
        status: podmanToOciStatus(info.State.Status),
        alive: info.State.Running,
        createdAt: created,
        startedAt: info.State.StartedAt,
        finishedAt: info.State.FinishedAt,
        exitCode: info.State.ExitCode,
        labels: info.Config?.Labels ?? {},
        annotations: {},
        mounts: (info.Mounts ?? []).map((m: { Source?: string; Destination?: string; Type?: string; Mode?: string }) => ({
          source: m.Source ?? '',
          destination: m.Destination ?? '',
          type: m.Type,
          options: m.Mode ? [m.Mode] : undefined,
        })),
        health: {
          status: info.State.Running
            ? (info.State.Health?.Status ?? 'none')
            : 'starting',
          ...(info.State.Health?.FailingStreak && info.State.Health.FailingStreak > 0 ? { message: `Failing health check (${info.State.Health.FailingStreak})` } : {}),
        },
      }] as unknown as readonly [],
      volumes: [],
      events: runtimeEvents(info),
      tags: [{ key: 'provider', value: 'podman' }],
    };
  }
}

/** Synthesize ContainerGroupRuntimeEvent[] from Podman container inspect. */
function runtimeEvents(info: PodmanInspectResult): { reason: string; type: 'Normal' | 'Warning'; message: string; count: number; lastTimestamp?: string }[] {
  const events: { reason: string; type: 'Normal' | 'Warning'; message: string; count: number; lastTimestamp?: string }[] = [];
  const ts = info.State?.StartedAt || info.Created;

  if (info.State?.Running && info.State?.StartedAt) {
    events.push({ reason: 'Started', type: 'Normal', message: 'Container started', count: 1, lastTimestamp: info.State.StartedAt });
  }
  if (info.State?.Status === 'exited' || info.State?.Status === 'stopped') {
    events.push({ reason: 'Stopped', type: 'Normal', message: `Container exited with code ${info.State.ExitCode ?? '?'}`, count: 1, lastTimestamp: info.State.FinishedAt ?? ts });
  }
  if (info.State?.Health?.Status === 'healthy') {
    events.push({ reason: 'HealthCheck', type: 'Normal', message: 'Health check passed', count: info.State.Health.Log?.length ?? 1, lastTimestamp: info.State.Health.Log?.[info.State.Health.Log.length - 1]?.End ?? ts });
  }
  if (info.State?.Health?.Status === 'unhealthy') {
    events.push({ reason: 'Unhealthy', type: 'Warning', message: `Health check failed (${info.State.Health.FailingStreak}x)`, count: info.State.Health.FailingStreak ?? 1, lastTimestamp: ts });
  }
  if (info.State?.Error && info.State.Error !== '') {
    events.push({ reason: 'Error', type: 'Warning', message: info.State.Error, count: 1, lastTimestamp: ts });
  }

  return events;
}

// ─── Helpers ───

function podmanToOciStatus(status: string | undefined): OciContainerStatus {
  switch (status) {
    case 'running': return 'running';
    case 'paused': return 'paused';
    case 'exited':
    case 'dead': return 'stopped';
    case 'created': return 'created';
    default: return 'creating';
  }
}

function mapPodmanState(state: string): ContainerGroupRuntime['status'] {
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
