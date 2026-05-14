// ─── Provider abstraction layer ───
// Every cloud operation goes through these interfaces.
// Concrete implementations (Alibaba, AWS, GCP, Azure) live under src/providers/.
//
// Design invariants:
// - All input/output types are provider-agnostic — no Alibaba/AWS types leak through.
// - Each provider method maps 1:1 to a remote API call from script0.
// - Provider-specific config lives in an opaque `providerConfig` bag per sandbox,
//   so the business layer never branches on provider identity.

import type {
  CreateSandboxInput,
  SandboxId,
  Sandbox,
  SandboxStatus,
  MetricSnapshot,
} from '../../features/sandbox/types.ts';

// ─── Container operations ───

export interface DescribeSandboxesInput {
  readonly region: string;
  readonly sandboxName?: string;
  readonly sandboxId?: SandboxId;
  readonly status?: SandboxStatus;
  readonly limit?: number;
  readonly nextToken?: string;
}

export interface DescribeSandboxesResult {
  readonly sandboxes: readonly Sandbox[];
  readonly nextToken?: string;
  readonly totalCount?: number;
}

export interface DeleteSandboxInput {
  readonly region: string;
  readonly providerId: string;
}

export interface GetContainerLogInput {
  readonly region: string;
  readonly providerId: string;
  readonly containerName: string;
  readonly limitBytes?: number;
  readonly sinceSeconds?: number;
  readonly timestamps?: boolean;
}

export interface ContainerLogResult {
  readonly containerName: string;
  readonly content: string;
  readonly timestamp?: string;
}

export interface IContainerProvider {
  /** Create a new sandbox. Returns the provider-assigned ID. */
  create(input: CreateSandboxInput): Promise<{ providerId: string }>;

  /** Query sandboxes by filters. */
  describe(input: DescribeSandboxesInput): Promise<DescribeSandboxesResult>;

  /** Delete a sandbox by provider ID. */
  delete(input: DeleteSandboxInput): Promise<void>;

  /** Fetch container stdout/stderr logs. */
  getLogs(input: GetContainerLogInput): Promise<ContainerLogResult>;
}

// ─── DNS operations ───

export interface UpdateDnsRecordInput {
  readonly domain: string;
  readonly type: 'A' | 'CNAME';
  readonly value: string;
  readonly ttl: number;
  readonly proxied: boolean;
  /** Provider-specific record identifier (e.g. Cloudflare record ID). */
  readonly providerRecordId: string;
  /** Provider-specific zone identifier. */
  readonly zoneId: string;
}

export interface DeleteDnsRecordInput {
  readonly zoneId: string;
  readonly providerRecordId: string;
}

export interface IDnsProvider {
  /** Create or update a DNS record. */
  updateRecord(input: UpdateDnsRecordInput): Promise<void>;

  /** Delete a DNS record. */
  deleteRecord(input: DeleteDnsRecordInput): Promise<void>;
}

// ─── Metrics operations ───

export interface FetchMetricsInput {
  readonly region: string;
  readonly providerId: string;
  readonly periodSeconds?: number;
  readonly startTime?: number;
  readonly endTime?: number;
}

export interface FetchMetricsResult {
  readonly snapshots: readonly MetricSnapshot[];
}

export interface IMetricsProvider {
  /** Fetch monitoring metrics for a sandbox. */
  fetchMetrics(input: FetchMetricsInput): Promise<FetchMetricsResult>;
}

// ─── Provider capability declaration ───

/** Each provider declares which optional capabilities it supports. */
export interface ProviderCapabilities {
  readonly spotInstances: boolean;
  readonly nfsVolumes: boolean;
  readonly publicIpAutoAssign: boolean;
  readonly preemptible: boolean;
  /** Max seconds a sandbox can run before being forcibly terminated (0 = unlimited). */
  readonly maxRuntimeSeconds: number;
}

export interface IProviderRegistry {
  readonly container: IContainerProvider;
  readonly dns: IDnsProvider;
  readonly metrics: IMetricsProvider;
  readonly capabilities: ProviderCapabilities;
}
