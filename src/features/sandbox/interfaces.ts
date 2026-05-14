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
  VolumeId,
  Volume,
  DnsRecordId,
  DnsRecord,
  MetricSnapshot,
  CreateSandboxInput,
} from './types.ts';

// ─── Repository interfaces (persistence abstraction) ───

export interface ISandboxRepository {
  /** Load a sandbox by its domain ID. */
  getById(id: SandboxId): Promise<Sandbox | null>;

  /** Persist a new sandbox. Fails if the ID already exists. */
  create(sandbox: Sandbox): Promise<void>;

  /** Update an existing sandbox with optimistic concurrency. */
  update(sandbox: Sandbox, expectedVersion: string): Promise<string | null>;

  /** List sandboxes matching a filter. Cursor-based pagination. */
  list(filter: SandboxListFilter): Promise<SandboxListResult>;

  /** List sandbox IDs by status (optimized for cleanup scanning). */
  listIdsByStatus(statuses: readonly SandboxStatus[], olderThanMs?: number): Promise<SandboxId[]>;
}

export interface SandboxListFilter {
  readonly status?: SandboxStatus;
  readonly name?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SandboxListResult {
  readonly items: readonly Sandbox[];
  readonly nextCursor?: string;
}

export interface IVolumeRepository {
  getById(id: VolumeId): Promise<Volume | null>;
  create(volume: Volume): Promise<void>;
  list(): Promise<readonly Volume[]>;
}

export interface IDnsRecordRepository {
  getById(id: DnsRecordId): Promise<DnsRecord | null>;
  getByDomain(domain: string): Promise<DnsRecord | null>;
  getBySandboxId(sandboxId: SandboxId): Promise<readonly DnsRecord[]>;
  create(record: DnsRecord): Promise<void>;
  update(record: DnsRecord, expectedVersion: string): Promise<string | null>;
  delete(id: DnsRecordId): Promise<void>;
  /** Find active records whose sandbox no longer exists. */
  findStaleRecords(): Promise<readonly DnsRecord[]>;
}

export interface IMetricSnapshotRepository {
  create(snapshot: MetricSnapshot): Promise<void>;
  getBySandboxId(sandboxId: SandboxId, range: MetricTimeRange): Promise<readonly MetricSnapshot[]>;
  /** Delete snapshots older than the given timestamp. Returns count deleted. */
  prune(olderThanMs: number): Promise<number>;
}

export interface MetricTimeRange {
  readonly startTime: number;
  readonly endTime: number;
  readonly limit?: number;
}

// ─── Service interfaces (business logic contracts) ───

export interface ISandboxService {
  /** Request a new sandbox. Returns immediately with Pending status. */
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

// ─── Dependency bundle (injected by createApp) ───

export interface SandboxDependencies {
  readonly atomic: IAtomicStore;
  readonly logger: ILogWriter;
  readonly containerProvider: IContainerProvider;
  readonly dnsProvider: IDnsProvider;
  readonly metricsProvider: IMetricsProvider;
}
