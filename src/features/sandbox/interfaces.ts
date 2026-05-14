import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
import type {
  IContainerProvider,
  IDnsProvider,
  IMetricsProvider,
  ContainerLogResult,
} from '../../core/provider/interfaces.ts';
import type {
  SandboxId,
  Sandbox,
  SandboxStatus,
  MetricSnapshot,
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
}

export interface ISandboxDnsService {
  /** Poll the provider for a sandbox's public IP until available or timeout. */
  pollForIp(sandboxId: SandboxId, timeoutMs: number, pollIntervalMs: number): Promise<string | null>;

  /** Create or update the DNS record pointing to the sandbox IP. */
  syncDns(sandboxId: SandboxId): Promise<void>;

  /** Remove DNS records associated with a sandbox. */
  cleanupDns(sandboxId: SandboxId): Promise<void>;
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
  readonly dnsProvider: IDnsProvider;
  readonly metricsProvider: IMetricsProvider;
}
