// ─── Cleanup task ───

/** Outcome of a single cleanup action, used for audit logging. */
export interface CleanupResult {
  readonly targetId: string;
  readonly success: boolean;
  readonly reason?: string;
}

/** A registered cleanup routine scanned and executed on a schedule. */
export interface ICleanupTask {
  /** Human-readable name, used in log facility. */
  readonly name: string;

  /** Scan for cleanup candidates. Returns IDs to process. */
  scan(): Promise<string[]>;

  /** Execute cleanup for one candidate. Idempotent. */
  cleanup(id: string): Promise<CleanupResult>;

  /** Interval between scan batches (ms). */
  readonly intervalMs: number;

  /** Max items to clean per batch (prevents API rate-limit storms). */
  readonly batchLimit: number;
}

// ─── Poller ───

export interface ICleanupPoller {
  /** Register a task. Must be called before start(). */
  register(task: ICleanupTask): void;

  /** Begin polling all registered tasks on their configured intervals. */
  start(): void;

  /** Stop polling. Waits for in-flight batches to complete. */
  stop(): Promise<void>;
}

// ─── Built-in task configurations (implementation guidance) ───

export interface ZombieSandboxTaskConfig {
  /** Statuses considered "zombie" candidates. */
  readonly candidateStatuses: readonly string[];
  /** Minimum age (ms) before a candidate is eligible for cleanup. */
  readonly minAgeMs: number;
  readonly intervalMs: number;
  readonly batchLimit: number;
}

export interface StaleDnsTaskConfig {
  readonly intervalMs: number;
  readonly batchLimit: number;
}

export interface ExpiredMetricsTaskConfig {
  /** Maximum age (ms) of metrics before they become eligible for deletion. */
  readonly maxAgeMs: number;
  readonly intervalMs: number;
  readonly batchLimit: number;
}

export interface StuckProvisionTaskConfig {
  /** Max time (ms) a sandbox can stay in Pending/Scheduling before considered stuck. */
  readonly timeoutMs: number;
  readonly intervalMs: number;
  readonly batchLimit: number;
}

export const DEFAULT_ZOMBIE_SANDBOX_CONFIG: ZombieSandboxTaskConfig = {
  candidateStatuses: ['Terminated', 'Failed'],
  minAgeMs: 6 * 60 * 60 * 1000, // 6 hours
  intervalMs: 30 * 60 * 1000, // 30 minutes
  batchLimit: 10,
};

export const DEFAULT_STALE_DNS_CONFIG: StaleDnsTaskConfig = {
  intervalMs: 30 * 60 * 1000,
  batchLimit: 20,
};

export const DEFAULT_EXPIRED_METRICS_CONFIG: ExpiredMetricsTaskConfig = {
  maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  intervalMs: 24 * 60 * 60 * 1000, // 24 hours
  batchLimit: 100,
};

export const DEFAULT_STUCK_PROVISION_CONFIG: StuckProvisionTaskConfig = {
  timeoutMs: 15 * 60 * 1000, // 15 minutes
  intervalMs: 5 * 60 * 1000, // 5 minutes
  batchLimit: 5,
};
