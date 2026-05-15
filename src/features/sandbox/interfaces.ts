import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
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

  /** Stop a running sandbox. */
  stop(id: SandboxId): Promise<Sandbox>;

  /** Destroy a sandbox and release all provider resources. */
  terminate(id: SandboxId): Promise<void>;

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

export interface SandboxDependencies {
  readonly atomic: IAtomicStore;
  readonly logger: ILogWriter;
  readonly containerProvider: IContainerProvider;
  readonly metricsProvider: IMetricsProvider;
}
