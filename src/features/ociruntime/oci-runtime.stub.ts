// ─── Stub OCI Runtime — Container Simulator ───
// Models five dimensions: container info, network, storage, logs, health check.
// Cloud orchestration creates instances → OCI Runtime manages them.
//
// Container info: name, image, args, env, workingDir, labels, annotations
// Network:        IP (172.17.0.x), gateway, port mappings
// Storage:        volume/directory mounts
// Logs:           image-aware startup + console output
// Health check:   simulated probe with starting → healthy/unhealthy transitions

import type { IOCIRuntime } from './interfaces.ts';
import type {
  ContainerId,
  OciContainer,
  OciContainerStatus,
  OciHealthStatus,
} from '../../core/provider/types.ts';
import { createContainerId } from '../../core/provider/types.ts';
import type {
  OciImageRef,
  OciImageInfo,
  OciCreateSpec,
  OciLogOptions,
} from './types.ts';

// ─── Internal state ───

interface MutableContainer {
  id: ContainerId;
  name: string;
  image: OciImageRef;
  args: readonly string[];
  env: Record<string, string>;
  workingDir: string;
  status: OciContainerStatus;
  alive: boolean;
  createdAt: string;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  exitCode?: number | undefined;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  mounts: readonly { source: string; destination: string; type?: string | undefined; options?: readonly string[] | undefined }[];
  ports: readonly { containerPort: number; hostPort?: number | undefined; protocol: 'tcp' | 'udp' }[];
  resources?: { cpu?: number | undefined; memory?: number | undefined; pids?: number | undefined } | undefined;
  healthSpec: { test: readonly string[]; intervalSeconds: number; timeoutSeconds: number; retries: number; startPeriodSeconds: number } | null;
  ipAddress?: string;
  logLines: string[];
}

let nextIp = 2;
let nextId = 1;

function allocateIp(): string { return `172.17.0.${nextIp++}`; }

/** Build the frozen view returned to callers. */
function snapshot(c: MutableContainer): OciContainer {
  const running = c.status === 'running';
  const health = computeHealth(c);

  return {
    id: c.id,
    name: c.name,
    image: c.image,
    args: c.args,
    env: c.env,
    workingDir: c.workingDir,
    status: c.status,
    alive: c.alive,
    createdAt: c.createdAt,
    startedAt: c.startedAt,
    finishedAt: c.finishedAt,
    exitCode: c.exitCode,
    labels: c.labels,
    annotations: c.annotations,
    mounts: c.mounts,
    ...(c.ipAddress || c.ports.length > 0 ? {
      network: {
        ipAddress: c.ipAddress ?? '0.0.0.0',
        gateway: '172.17.0.1',
        ports: c.ports.map(p => ({ containerPort: p.containerPort, hostPort: p.hostPort, protocol: p.protocol })),
      },
    } : {}),
    ...(running && c.resources ? {
      resources: {
        cpu: c.resources.cpu ?? 2,
        memory: c.resources.memory ?? 512,
        cpuUsagePercent: +(5 + Math.random() * 40).toFixed(1),
        memoryUsageBytes: c.resources.memory
          ? Math.floor(c.resources.memory * 1024 * 1024 * (0.1 + Math.random() * 0.6))
          : Math.floor(32 * 1024 * 1024 + Math.random() * 64 * 1024 * 1024),
        memoryLimitBytes: c.resources.memory ? c.resources.memory * 1024 * 1024 : 256 * 1024 * 1024,
        pidsCurrent: Math.floor(5 + Math.random() * 20),
      },
    } : {}),
    health,
  };
}

function computeHealth(c: MutableContainer): { status: OciHealthStatus; lastCheckedAt?: string; message?: string; failingSince?: string } {
  if (!c.healthSpec) return { status: 'none' };
  if (c.status !== 'running') return { status: 'none' };

  const uptime = c.startedAt ? Date.now() - new Date(c.startedAt).getTime() : 0;
  const startPeriodMs = c.healthSpec.startPeriodSeconds * 1000;

  // Still in start period
  if (uptime < startPeriodMs) {
    return { status: 'starting', lastCheckedAt: new Date().toISOString(), message: 'Container starting, health check not yet active' };
  }

  // Running + past start period → healthy
  const sinceHealthy = Math.floor((uptime - startPeriodMs) / 1000 / c.healthSpec.intervalSeconds);
  if (sinceHealthy < 2) {
    return { status: 'starting', lastCheckedAt: new Date().toISOString(), message: `Probe "${c.healthSpec.test.join(' ')}" waiting for stabilisation` };
  }

  return {
    status: 'healthy',
    lastCheckedAt: new Date().toISOString(),
    message: `Probe "${c.healthSpec.test.join(' ')}" succeeded`,
  };
}

// ─── Image-aware log generators ───

const logGenerators = new Map<string, (name: string, image: string, ip: string | undefined, ports: readonly { containerPort: number }[], args: readonly string[]) => string[]>();

function reg(pattern: string, fn: typeof logGenerators extends Map<string, infer V> ? V : never) {
  logGenerators.set(pattern.toLowerCase(), fn);
}

reg('nginx', (name) => [
  `[boot] ${name}: nginx ${Math.floor(1 + Math.random() * 26)}.${Math.floor(Math.random() * 99)} started`,
  `[boot] ${name}: worker process running`,
  `[boot] ${name}: accepting connections on port 80`,
]);

reg('node', (name, _img, _ip, ports) => [
  `[boot] ${name}: Node.js server starting...`,
  `[boot] ${name}: listening on port ${ports[0]?.containerPort ?? 3000}`,
  `[boot] ${name}: worker online`,
]);

reg('redis', (name) => [
  `[boot] ${name}: Redis ${Math.floor(6 + Math.random() * 2)}.${Math.floor(Math.random() * 99)} starting`,
  `[boot] ${name}: running in standalone mode on port 6379`,
  `[boot] ${name}: ready to accept connections`,
]);

reg('postgres', (name) => [
  `[boot] ${name}: PostgreSQL ${Math.floor(13 + Math.random() * 5)}.${Math.floor(Math.random() * 10)} starting`,
  `[boot] ${name}: database system was shut down at ${new Date().toUTCString()}`,
  `[boot] ${name}: database system is ready to accept connections`,
]);

reg('steamcmd', (name, _img, ip, ports) => [
  `[boot] ${name}: Steam Console Client (c) Valve Corporation`,
  `[boot] ${name}: logging directory /home/container/.local/share/Steam/logs`,
  `[boot] ${name}: game server ready on ${ip ?? '0.0.0.0'}:${ports[0]?.containerPort ?? 27015}`,
]);

reg('l4d2', (name, _img, ip, ports) => [
  `[boot] ============ Left 4 Dead 2 ============`,
  `[boot] ${name}: version ${Math.floor(2 + Math.random())}.${Math.floor(Math.random() * 10)}.${Math.floor(Math.random() * 10)}`,
  `[boot] ${name}: server IP ${ip ?? '0.0.0.0'}:${ports[0]?.containerPort ?? 27015}`,
  `[boot] ${name}: connection to Steam servers successful`,
  `[boot] ${name}: ready`,
]);

reg('ftp', (name, _img, _ip, ports) => [
  `[boot] ${name}: FTP server starting on port ${ports[0]?.containerPort ?? 21}`,
  `[boot] ${name}: anonymous access ${Math.random() > 0.5 ? 'enabled' : 'disabled'}`,
  `[boot] ${name}: FTP server ready`,
]);

function genLogs(c: MutableContainer): string[] {
  const lower = c.image.toLowerCase();
  for (const [pattern, gen] of logGenerators) {
    if (lower.includes(pattern)) {
      return gen(c.name, c.image, c.ipAddress, c.ports, c.args);
    }
  }
  return [
    `[boot] ${c.name}: container started (image: ${c.image.split('/').pop()})`,
    `[boot] ${c.name}: process running entrypoint`,
    ...(c.args.length > 0 ? [`[boot] ${c.name}: args: ${c.args.join(' ')}`] : []),
    ...(c.ports.length > 0 ? [`[boot] ${c.name}: listening on 0.0.0.0:${c.ports[0]!.containerPort}`] : []),
  ];
}

// ─── Implementation ───

export class StubOciRuntime implements IOCIRuntime {
  #containers = new Map<string, MutableContainer>();
  #images = new Map<string, OciImageInfo>();

  async pullImage(image: OciImageRef): Promise<OciImageInfo> {
    const existing = this.#images.get(image);
    if (existing) return existing;

    const isGameServer = image.includes('l4d2') || image.includes('steamcmd');
    const size = isGameServer ? 2_500_000_000 : image.includes('node') ? 950_000_000 : image.includes('nginx') ? 180_000_000 : 100_000_000;

    const info: OciImageInfo = { ref: image, digest: `sha256:${'f'.repeat(64)}`, size, pulledAt: new Date().toISOString() };
    this.#images.set(image, info);
    return info;
  }

  async listImages(): Promise<readonly OciImageInfo[]> {
    return [...this.#images.values()];
  }

  async removeImage(image: OciImageRef): Promise<void> {
    this.#images.delete(image);
  }

  async createContainer(spec: OciCreateSpec): Promise<OciContainer> {
    if (!this.#images.has(spec.image)) await this.pullImage(spec.image);

    const id = createContainerId(`oci-${nextId++}`);
    const now = new Date().toISOString();

    const c: MutableContainer = {
      id, name: spec.name, image: spec.image, args: spec.args ?? [], env: spec.env ?? {},
      workingDir: spec.workingDir ?? '/', status: 'created', alive: false, createdAt: now,
      labels: spec.labels ?? {}, annotations: spec.annotations ?? {},
      mounts: spec.mounts ?? [],
      ports: spec.ports ?? [],
      ...(spec.resources ? {
        resources: {
          ...(spec.resources.cpu !== undefined ? { cpu: spec.resources.cpu } : {}),
          ...(spec.resources.memory !== undefined ? { memory: spec.resources.memory } : {}),
          ...(spec.resources.pids !== undefined ? { pids: spec.resources.pids } : {}),
        },
      } : {}),
      healthSpec: spec.healthCheck ? {
        test: spec.healthCheck.test,
        intervalSeconds: spec.healthCheck.intervalSeconds ?? 30,
        timeoutSeconds: spec.healthCheck.timeoutSeconds ?? 30,
        retries: spec.healthCheck.retries ?? 3,
        startPeriodSeconds: spec.healthCheck.startPeriodSeconds ?? 0,
      } : null,
      logLines: [],
    };

    this.#containers.set(id, c);
    return snapshot(c);
  }

  async startContainer(id: ContainerId): Promise<void> {
    const c = this.#containers.get(id);
    if (!c) throw new Error(`Container ${id} not found`);
    if (c.status !== 'created') throw new Error(`Cannot start container in state: ${c.status}`);

    c.status = 'running';
    c.alive = true;
    c.startedAt = new Date().toISOString();
    c.ipAddress = allocateIp();
    c.logLines = genLogs(c);
  }

  async stopContainer(id: ContainerId, timeoutSeconds?: number): Promise<void> {
    const c = this.#containers.get(id);
    if (!c) throw new Error(`Container ${id} not found`);
    if (c.status !== 'running' && c.status !== 'paused') throw new Error(`Container ${id} is ${c.status}, expected running`);

    c.logLines.push(`[${new Date().toISOString()}] received SIGTERM, shutting down...`);
    if (timeoutSeconds && timeoutSeconds > 0) {
      c.logLines.push(`[${new Date().toISOString()}] waiting ${timeoutSeconds}s for active connections to drain`);
    }
    c.logLines.push(`[${new Date().toISOString()}] exited`);

    c.alive = false;
    c.status = 'stopped';
    c.finishedAt = new Date().toISOString();
    c.exitCode = 0;
  }

  async killContainer(id: ContainerId, signal?: string): Promise<void> {
    const c = this.#containers.get(id);
    if (!c) throw new Error(`Container ${id} not found`);
    c.logLines.push(`[${new Date().toISOString()}] received ${signal ?? 'SIGKILL'}, forced shutdown`);
    c.alive = false;
    c.status = 'stopped';
    c.finishedAt = new Date().toISOString();
    c.exitCode = signal === 'SIGKILL' || signal === '9' ? 137 : 143;
  }

  async pauseContainer(id: ContainerId): Promise<void> {
    const c = this.#containers.get(id);
    if (!c) throw new Error(`Container ${id} not found`);
    if (c.status !== 'running') throw new Error(`Container ${id} is ${c.status}, expected running`);
    c.logLines.push(`[${new Date().toISOString()}] cgroup frozen`);
    c.status = 'paused';
  }

  async unpauseContainer(id: ContainerId): Promise<void> {
    const c = this.#containers.get(id);
    if (!c) throw new Error(`Container ${id} not found`);
    if (c.status !== 'paused') throw new Error(`Container ${id} is ${c.status}, expected paused`);
    c.logLines.push(`[${new Date().toISOString()}] cgroup unfrozen, resuming`);
    c.status = 'running';
  }

  async removeContainer(id: ContainerId): Promise<void> {
    const c = this.#containers.get(id);
    if (!c) throw new Error(`Container ${id} not found`);
    if (c.status === 'running') throw new Error(`Cannot remove running container ${id}`);
    this.#containers.delete(id);
  }

  async inspectContainer(id: ContainerId): Promise<OciContainer | null> {
    const c = this.#containers.get(id);
    return c ? snapshot(c) : null;
  }

  async listContainers(status?: OciContainerStatus): Promise<readonly OciContainer[]> {
    const all = [...this.#containers.values()];
    return (status ? all.filter(c => c.status === status) : all).map(snapshot);
  }

  async getLogs(id: ContainerId, options?: OciLogOptions): Promise<string> {
    const c = this.#containers.get(id);
    if (!c) throw new Error(`Container ${id} not found`);

    let lines = c.logLines;
    if (options?.tail && options.tail > 0) lines = lines.slice(-options.tail);

    if (options?.timestamps) {
      lines = lines.map(l => `${new Date().toISOString()} ${l}`);
    }

    return lines.join('\n') + '\n';
  }
}
