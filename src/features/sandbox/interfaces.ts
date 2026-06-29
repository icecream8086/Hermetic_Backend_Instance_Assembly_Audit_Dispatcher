import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import type {
  IContainerProvider,
  IMetricsProvider,
  ContainerLogResult,
  MetricSnapshot,
  ContainerGroupRuntime,
} from '../../core/provider/index.ts';
import type {
  SandboxId,
  Sandbox,
  SandboxStatus,
  CreateSandboxInput,
} from './types.ts';

// ─── Service interfaces (business logic contracts) ───

export interface ISandboxService {
  /** Request a new sandbox. Returns immediately with Running status. */
  provision(input: CreateSandboxInput, idempotencyKey?: string): Promise<Sandbox>;

  /** Get current sandbox state. */
  getById(id: SandboxId): Promise<Sandbox | null>;

  /** List sandboxes with optional status filter. */
  list?(status?: SandboxStatus, limit?: number, cursor?: string): Promise<{ items: Sandbox[]; nextCursor?: string }>;

  /** Stop a running sandbox. */
  stop(id: SandboxId): Promise<Sandbox>;

  /** Start a stopped sandbox. */
  start?(id: SandboxId): Promise<Sandbox>;

  /** Destroy a sandbox and release all provider resources. */
  terminate(id: SandboxId, actorId?: string): Promise<void>;

  /** Force a state transition (admin use only). */
  forceTransition(id: SandboxId, to: SandboxStatus, reason: string): Promise<Sandbox>;

  /**
   * Sync the sandbox entity with the provider's real-time resource state.
   * Updates network, containers, events from the provider and optionally
   * transitions status if the provider reports a terminal state.
   * Returns the raw runtime data from the provider.
   */
  syncRuntime(id: SandboxId): Promise<ContainerGroupRuntime>;

  /**
   * Poll the sandbox's atomic store until a public IP is available, or timeout.
   * Returns the IP or null if timed out.
   */
  pollForIp(sandboxId: SandboxId, timeoutMs: number, pollIntervalMs: number): Promise<string | null>;

  /** Get health status for all containers in a sandbox. */
  getHealth(id: SandboxId): Promise<readonly ContainerHealth[]>;

  /** Restart a running sandbox. ECI: RestartContainerGroup. Only valid from Running. */
  restart(id: SandboxId): Promise<Sandbox>;

  /** Update a running sandbox's specification. ECI: UpdateContainerGroup. Only valid from Running. */
  update(id: SandboxId, input: Partial<CreateSandboxInput>): Promise<Sandbox>;
}

export interface ISandboxMetricsService {
  /** Fetch the latest metrics from the provider and persist them. */
  collect(sandboxId: SandboxId): Promise<readonly MetricSnapshot[]>;

  /** Query persisted metrics for a time range. */
  query(sandboxId: SandboxId, range: MetricTimeRange): Promise<readonly MetricSnapshot[]>;
}

export interface ISandboxLogService {
  /** Fetch container logs from the provider. */
  getLogs(sandboxId: SandboxId, containerName: string, options?: LogQueryOptions): Promise<ContainerLogResult>;
}

export interface ContainerHealth {
  readonly containerName: string;
  readonly status: string;       // OciHealthStatus as string
  readonly ready: boolean;
  readonly startedAt?: string | undefined;
  readonly message?: string | undefined;
}

export interface LogQueryOptions {
  readonly limitBytes?: number;
  readonly sinceSeconds?: number;
  readonly timestamps?: boolean;
}

export interface MetricTimeRange {
  readonly startTime: number;
  readonly endTime: number;
  readonly limit?: number;
}

// ─── Dependency bundle (injected by createApp) ───

// ─── Pod ↔ Sandbox ↔ Provider mapping ───

export interface IPodMappingService {
  /** Record a new mapping between a K8s Pod UID, a sandbox ID, and a provider instance ID. */
  bind(podUid: string, sandboxId: string, providerId?: string): Promise<void>;

  /** Look up a sandbox ID by K8s Pod UID. */
  getSandboxByPod(podUid: string): Promise<string | null>;

  /** Look up a sandbox ID by provider instance ID. */
  getSandboxByProvider(providerId: string): Promise<string | null>;

  /** Look up the provider instance ID for a sandbox. */
  getProviderBySandbox(sandboxId: string): Promise<string | null>;

  /** Remove a mapping (when sandbox is terminated). */
  unbind(podUid: string): Promise<void>;
}

export interface SandboxDependencies {
  readonly atomic: IAtomicStore;
  readonly logger: IAuditWriter;
  readonly containerProvider: IContainerProvider;
  readonly metricsProvider: IMetricsProvider;
}
