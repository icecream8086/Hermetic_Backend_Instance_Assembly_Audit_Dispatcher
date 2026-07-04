/**
 * PodmanPodCodec — CEA bidirectional codec for Podman libpod pods API (v5).
 *
 * Implements PodCodec<PodmanCreateRequest>.
 *   encode: PodSpec → PodmanCreateRequest (pod + containers create bodies)
 *   decode: raw inspect bundle → PodRuntime
 *   decodeStatus: raw pod state → PodPhase
 */

import { z } from 'zod';
import type { PodCodec } from '../../core/pod/codec.ts';
import type { PodSpec, PodRuntime, PodPhase, ContainerState, PodCondition } from '../../core/pod/types.ts';
import { createPodId } from '../../core/pod/types.ts';
import type { ContainerSpec } from '../../core/pod/types.ts';

// ═══════════════════════════════════════════════════════════════
// Podman native types — the "wire format" for create requests
// ═══════════════════════════════════════════════════════════════

export interface PodmanPortMapping {
  readonly containerPort: number;
  readonly hostPort?: number | undefined;
  readonly protocol?: string | undefined;
}

export interface PodmanPodCreateBody {
  readonly name: string;
  readonly labels?: Record<string, string> | undefined;
  readonly share?: readonly string[] | undefined;
  readonly infra?: boolean | undefined;
  readonly publish?: readonly PodmanPortMapping[] | undefined;
  readonly networks?: readonly { readonly name: string }[] | undefined;
  readonly dnsServers?: readonly string[] | undefined;
  readonly dnsOptions?: readonly string[] | undefined;
  readonly dnsSearches?: readonly string[] | undefined;
  readonly addHosts?: readonly string[] | undefined;
  readonly cpus?: number | undefined;
  readonly memory?: string | undefined;
  readonly terminationGracePeriodSeconds?: number | undefined;
}

export interface PodmanContainerCreateBody {
  readonly name: string;
  readonly Image: string;
  readonly Entrypoint?: readonly string[] | undefined;
  readonly Cmd?: readonly string[] | undefined;
  readonly Env?: readonly string[] | undefined;
  readonly Labels?: Record<string, string> | undefined;
  readonly Healthcheck?: Record<string, unknown> | undefined;
  readonly TTY?: boolean | undefined;
  readonly Stdin?: boolean | undefined;
  readonly WorkingDir?: string | undefined;
  readonly Mounts?: readonly PodmanContainerMount[] | undefined;
}

export interface PodmanContainerMount {
  readonly Source: string;
  readonly Destination: string;
  readonly Type?: string | undefined;
  readonly Mode?: string | undefined;
}

/** The complete create request — pod body + all container bodies. */
export interface PodmanCreateRequest {
  readonly pod: PodmanPodCreateBody;
  readonly containers: readonly PodmanContainerCreateBody[];
  readonly initContainers?: readonly PodmanContainerCreateBody[] | undefined;
}

// ═══════════════════════════════════════════════════════════════
// Zod schemas for decode input validation
// ═══════════════════════════════════════════════════════════════

const podmanContainerInspectSchema = z.object({
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

const podmanInspectBundleSchema = z.object({
  pod: z.object({
    Id: z.string(),
    Name: z.string(),
    State: z.string(),
    Containers: z.array(z.object({
      Id: z.string(),
      Name: z.string(),
      State: z.string(),
    })).optional(),
    Labels: z.record(z.string(), z.string()).optional(),
    Created: z.string().optional(),
  }),
  containers: z.array(podmanContainerInspectSchema).optional(),
});

type PodmanInspectBundle = z.infer<typeof podmanInspectBundleSchema>;

// ═══════════════════════════════════════════════════════════════
// PodmanPodCodec
// ═══════════════════════════════════════════════════════════════

export class PodmanPodCodec implements PodCodec<PodmanCreateRequest> {
  public readonly providerId = 'podman';

  // ── encode: PodSpec → PodmanCreateRequest ──

  public encode(input: PodSpec): PodmanCreateRequest {
    const portMappings = collectPortMappings(input.spec.containers);

    const labels: Record<string, string> = {
      'managed-by': 'hbi-aad',
      ...input.metadata.labels,
      ...(input.spec.priority !== undefined ? { 'hbi-priority': String(input.spec.priority) } : {}),
    };

    const dnsConfig = input.spec.dnsConfig;
    const dnsServers = dnsConfig?.nameservers?.length ? dnsConfig.nameservers : undefined;
    const dnsSearches = dnsConfig?.searches?.length ? dnsConfig.searches : undefined;
    const dnsOptions = dnsConfig?.options?.length
      ? dnsConfig.options.map(o => o.value ? `${o.name}:${o.value}` : o.name)
      : undefined;

    const addHosts = input.spec.hostAliases?.flatMap(h =>
      h.hostnames.map(hn => `${hn}:${h.ip}`),
    );

    const networkName = extractNetworkOverride(input.providerOverrides);

    const totalCpu = input.spec.containers.reduce((s, c) => s + (c.resources?.limits?.cpu ?? 0), 0);
    const totalMem = input.spec.containers.reduce((s, c) => s + (c.resources?.limits?.memory ?? 0), 0);
    const terminationGracePeriodSeconds = input.spec.terminationGracePeriodSeconds;

    const pod: PodmanPodCreateBody = {
      name: input.metadata.name,
      labels,
      share: ['net', 'uts', 'ipc'],
      infra: true,
      ...(portMappings.length > 0 ? { publish: portMappings } : {}),
      ...(dnsServers ? { dnsServers } : {}),
      ...(dnsSearches ? { dnsSearches } : {}),
      ...(dnsOptions ? { dnsOptions } : {}),
      ...(addHosts?.length ? { addHosts } : {}),
      ...(networkName ? { networks: [{ name: networkName }] } : {}),
      ...(totalCpu > 0 ? { cpus: totalCpu } : {}),
      ...(totalMem > 0 ? { memory: `${String(totalMem)}m` } : {}),
      ...(terminationGracePeriodSeconds !== undefined ? { terminationGracePeriodSeconds } : {}),
    };

    const containers = input.spec.containers.map(c => containerToCreateBody(c, false));
    const initContainers = input.spec.initContainers?.map(c => containerToCreateBody(c, true));

    return {
      pod,
      containers,
      ...(initContainers?.length ? { initContainers } : {}),
    };
  }

  // ── decode: inspect bundle → PodRuntime ──

  public decode(raw: unknown): PodRuntime {
    const bundle = podmanInspectBundleSchema.parse(raw);
    return inspectBundleToRuntime(bundle);
  }

  // ── decodeStatus: pod state → PodPhase ──

  public decodeStatus(raw: unknown): PodPhase {
    const state = z.string().parse(raw);
    return podmanStateToPhase(state);
  }
}

// ═══════════════════════════════════════════════════════════════
// Encode helpers
// ═══════════════════════════════════════════════════════════════

const networkOverrideSchema = z.string().optional();

function extractNetworkOverride(overrides: Record<string, unknown> | undefined): string | undefined {
  if (!overrides) return undefined;
  return networkOverrideSchema.parse(overrides.network);
}

function collectPortMappings(containers: readonly ContainerSpec[]): PodmanPortMapping[] {
  const mappings: PodmanPortMapping[] = [];
  for (const c of containers) {
    if (c.ports) {
      for (const p of c.ports) {
        mappings.push({
          containerPort: p.containerPort,
          ...(p.hostPort !== undefined ? { hostPort: p.hostPort } : {}),
          ...(p.protocol !== undefined ? { protocol: p.protocol } : {}),
        });
      }
    }
  }
  return mappings;
}

function containerToCreateBody(c: ContainerSpec, isInit: boolean): PodmanContainerCreateBody {
  const env: string[] = [];
  if (c.env) {
    for (const e of c.env) {
      if (e.value !== undefined) env.push(`${e.name}=${e.value}`);
      else env.push(e.name);
    }
  }

  const labels: Record<string, string> = {
    'managed-by': 'hbi-aad',
    service: c.name,
    ...(isInit ? { init: 'true' } : {}),
  };

  const healthcheck = buildPodmanHealthcheck(c.livenessProbe);

  const mounts = c.volumeMounts?.map(vm => ({
    Source: vm.volumeId,
    Destination: vm.mountPath,
    ...(vm.readOnly ? { Mode: 'ro' } : {}),
  } satisfies PodmanContainerMount));

  return {
    name: c.name,
    Image: c.image,
    ...(c.command?.length ? { Entrypoint: c.command } : {}),
    ...(c.args?.length ? { Cmd: c.args } : {}),
    ...(env.length > 0 ? { Env: env } : {}),
    Labels: labels,
    ...(healthcheck ? { Healthcheck: healthcheck } : {}),
    ...(c.tty !== undefined ? { TTY: c.tty } : {}),
    ...(c.stdin !== undefined ? { Stdin: c.stdin } : {}),
    ...(mounts?.length ? { Mounts: mounts } : {}),
  };
}

function buildPodmanHealthcheck(probe: ContainerSpec['livenessProbe']): Record<string, unknown> | undefined {
  if (!probe) return undefined;

  let hc: Record<string, unknown> | undefined;
  if (probe.exec?.command.length) {
    hc = { Test: ['CMD', ...probe.exec.command] };
  } else if (probe.httpGet !== undefined) {
    const { port, path } = probe.httpGet;
    hc = { Test: ['CMD', 'curl', '-sf', `http://localhost:${String(port)}${path}`] };
  } else if (probe.tcpSocket !== undefined) {
    hc = { Test: ['CMD-SHELL', `exec 3<>/dev/tcp/localhost/${String(probe.tcpSocket.port)}`] };
  }

  if (hc) {
    if (probe.initialDelaySeconds !== undefined) hc.StartPeriod = probe.initialDelaySeconds * 1_000_000_000;
    if (probe.periodSeconds !== undefined) hc.Interval = probe.periodSeconds * 1_000_000_000;
    if (probe.timeoutSeconds !== undefined) hc.Timeout = probe.timeoutSeconds * 1_000_000_000;
    if (probe.failureThreshold !== undefined) hc.Retries = probe.failureThreshold;
  }

  return hc;
}

// ═══════════════════════════════════════════════════════════════
// Decode helpers
// ═══════════════════════════════════════════════════════════════

type InspectContainer = z.infer<typeof podmanContainerInspectSchema>;

function inspectBundleToRuntime(bundle: PodmanInspectBundle): PodRuntime {
  const pod = bundle.pod;
  const containers = bundle.containers ?? [];

  const phase = podmanStateToPhase(pod.State);
  const ready: 'True' | 'False' = pod.State === 'Running' ? 'True' : 'False';
  const now = Date.now();

  const conditions: PodCondition[] = [
    { type: 'PodScheduled', status: 'True', lastTransitionTime: now },
    { type: 'ContainersReady', status: ready, lastTransitionTime: now },
  ];

  return {
    podId: createPodId(pod.Id),
    providerId: pod.Id,
    name: pod.Name,
    phase,
    conditions,
    containers: containers.map(c => inspectContainerToRuntime(c)),
    volumes: [],
    events: [],
    network: extractNetwork(containers),
    createdAt: pod.Created,
  };
}

function inspectContainerToRuntime(c: InspectContainer): {
  readonly name: string;
  readonly image: string;
  readonly state: ContainerState;
  readonly env: Record<string, string>;
  readonly ports?: readonly { readonly containerPort: number; readonly hostPort?: number | undefined; readonly protocol?: string | undefined }[];
  readonly resources?: { readonly cpu: number; readonly memory: number; readonly gpu?: number | undefined };
  readonly labels: Record<string, string>;
  readonly annotations: Record<string, string>;
  readonly mounts: readonly { readonly source: string; readonly destination: string; readonly type?: string | undefined }[];
} {
  const config = c.Config;
  const state = c.State;
  const hostConfig = c.HostConfig;

  const containerState: ContainerState = deriveContainerState(
    state?.Status,
    state?.Running,
    state?.ExitCode ?? 0,
    state?.StartedAt,
    state?.FinishedAt,
  );

  const cpu = hostConfig?.NanoCpus !== undefined
    ? hostConfig.NanoCpus / 1e9
    : (hostConfig?.CpuShares !== undefined ? hostConfig.CpuShares / 1024 : 0);
  const memory = hostConfig?.Memory !== undefined
    ? Math.round(hostConfig.Memory / 1024 / 1024)
    : 0;

  return {
    name: c.Name?.replace(/^\//, '') ?? '',
    image: config?.Image ?? '',
    state: containerState,
    env: parseEnvArray(config?.Env),
    labels: config?.Labels ?? {},
    annotations: {},
    mounts: (c.Mounts ?? []).map(m => ({
      source: m.Source ?? '',
      destination: m.Destination ?? '',
      ...(m.Type ? { type: m.Type } : {}),
    })),
    ...(cpu > 0 || memory > 0 ? { resources: { cpu, memory } } : {}),
  };
}

function deriveContainerState(
  status: string | undefined,
  running: boolean | undefined,
  exitCode: number,
  startedAt: string | undefined,
  finishedAt: string | undefined,
): ContainerState {
  if (running === true) {
    return { state: 'Running', startedAt: startedAt ?? '' };
  }
  if (status === 'exited' || status === 'dead' || status === 'stopped') {
    return {
      state: 'Terminated',
      exitCode,
      ...(startedAt ? { startedAt } : {}),
      ...(finishedAt ? { finishedAt } : {}),
    };
  }
  if (status === 'paused') {
    return { state: 'Running', startedAt: startedAt ?? '' };
  }
  if (status === 'created') {
    return { state: 'Waiting', reason: 'ContainerCreated' };
  }
  return { state: 'Waiting' };
}

function extractNetwork(containers: readonly InspectContainer[]): {
  readonly privateIp?: string | undefined;
} {
  for (const c of containers) {
    const ip = c.NetworkSettings?.IPAddress;
    if (ip) return { privateIp: ip };
  }
  return {};
}

// ═══════════════════════════════════════════════════════════════
// Podman state → PodPhase
// ═══════════════════════════════════════════════════════════════

function podmanStateToPhase(state: string): PodPhase {
  const s = state.toLowerCase();
  switch (s) {
    case 'created':
      return 'Pending';
    case 'running':
    case 'running (all containers)':
    case 'degraded':
      return 'Running';
    case 'stopped':
    case 'paused':
      return 'Succeeded';
    case 'exited':
      return 'Failed';
    default:
      return 'Unknown';
  }
}

// ═══════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════

function parseEnvArray(env?: string[]): Record<string, string> {
  if (!env?.length) return {};
  const out: Record<string, string> = {};
  for (const e of env) {
    const eq = e.indexOf('=');
    if (eq > 0) out[e.slice(0, eq)] = e.slice(eq + 1);
    else out[e] = '';
  }
  return out;
}
