import type { PermissionDependencies, IPermissionChecker } from './interfaces.ts';
import type { PolicyId, PolicyNode, PermissionCheck, PermissionResult, AuthzRecord, AuthzId } from './types.ts';
import { generateAuthzId } from './types.ts';
import { PermissionDag } from './permission-dag.ts';
import { HashTable } from '../hash-table/index.ts';
import { LinkedList } from '../linked-list/index.ts';
import { createFacility } from '../brand.ts';
import { LogLevel } from '../types.ts';
import { KernLevel } from '../audit/kern-level.ts';

const AUTHZ_FACILITY = createFacility('authz');

/** 7 days in seconds — matches audit KV TTL. */
const AUTHZ_TTL_SEC = 7 * 24 * 60 * 60;

/**
 * Base class for permission checks.
 *
 * Decisions are composed via a **directed acyclic graph** of policy nodes.
 * Each node declares an effect (ALLOW / DENY) and a `match()` predicate.
 * Evaluation follows **deny-overrides** in topological order:
 * any matching DENY immediately rejects; otherwise the first matching ALLOW
 * grants access.
 *
 * Every decision is recorded as:
 *  1. An `AuthzRecord` in the atomic store (KV log) at key `authz:{id}`
 *  2. An audit log entry via `ILogWriter`
 *
 * An in-memory `HashTable` caches recent decisions. A `LinkedList` buffers
 * recent records for in-process inspection.
 *
 * @example
 * ```ts
 * // Build a DAG of policies (no subclass needed)
 * const perm = new BasePermission(deps);
 * perm.addPolicy({
 *   id: createPolicyId('admin-rule'),
 *   effect: PermissionEffect.ALLOW,
 *   description: 'Admins bypass all checks',
 *   match: (p) => p.actor.startsWith('admin:'),
 * });
 * perm.addPolicy({
 *   id: createPolicyId('default-deny'),
 *   effect: PermissionEffect.DENY,
 *   description: 'Default deny',
 *   match: () => true,
 * });
 *
 * // Or subclass and wire policies in the constructor
 * class SandboxPermission extends BasePermission {
 *   constructor(deps: PermissionDependencies) {
 *     super(deps);
 *     this.addPolicy({ id: createPolicyId('owner'), effect: PermissionEffect.ALLOW, match: p => p.context?.owner === p.actor });
 *     this.addPolicy({ id: createPolicyId('deny-all'), effect: PermissionEffect.DENY, match: () => true });
 *   }
 * }
 * ```
 */
export class BasePermission implements IPermissionChecker {
  protected readonly deps: PermissionDependencies;

  /** Policy DAG — subclasses add policies in constructors. */
  protected readonly dag: PermissionDag;

  /** In-memory decision cache: "{actor}:{action}:{resource}:{resourceId}" → allowed. */
  protected readonly cache: HashTable<string, boolean>;

  /** In-memory recent-record buffer for in-process inspection. */
  protected readonly recentRecords: LinkedList<AuthzRecord>;

  /** Max number of recent records to keep in memory. */
  protected readonly maxRecent: number;

  constructor(deps: PermissionDependencies, maxRecent = 1_000) {
    this.deps = deps;
    this.dag = new PermissionDag();
    this.cache = new HashTable();
    this.recentRecords = new LinkedList();
    this.maxRecent = maxRecent;
  }

  // ─── DAG building ───

  /** Register a policy node in the DAG. */
  addPolicy(node: PolicyNode): void {
    this.dag.addPolicy(node);
  }

  /**
   * Add a dependency edge: `from` policy must be evaluated before `to`.
   * Both policies must already exist via `addPolicy`.
   */
  addDependency(from: PolicyId, to: PolicyId): void {
    this.dag.addDependency(from, to);
  }

  // ─── Main check ───

  /**
   * Evaluate the permission check against the policy DAG.
   *
   * 1. Check in-memory cache first (fast path, no persistence).
   * 2. Delegate to `dag.evaluate()` for topological-sort + deny-overrides.
   * 3. Persist the decision to KV + audit log.
   * 4. Update in-memory cache and record buffer.
   */
  async check(params: PermissionCheck): Promise<PermissionResult> {
    const cached = this.getCached(params);
    if (cached !== undefined) {
      return { allowed: cached, reason: cached ? 'Cached allow' : 'Cached deny' };
    }

    const evalResult = this.dag.evaluate(params);
    await this.record(params, evalResult);
    return { allowed: evalResult.allowed, reason: evalResult.reason };
  }

  // ─── Shared record & cache helpers ───

  /**
   * Persist an authorization decision to both:
   *  - Atomic store as `authz:{id}` (KV log)
   *  - Audit log via `ILogWriter.logSync()`
   *
   * Also updates the in-memory cache and recent-record buffer.
   * Returns the generated AuthzId for traceability.
   */
  protected async record(params: PermissionCheck, result: PermissionResult): Promise<AuthzId> {
    const id = generateAuthzId();
    const now = Date.now();

    const record: AuthzRecord = {
      id,
      actor: params.actor,
      action: params.action,
      resource: params.resource,
      resourceId: params.resourceId,
      allowed: result.allowed,
      reason: result.reason,
      timestamp: now,
      ...(params.context !== undefined ? { metadata: params.context } : {}),
    } as AuthzRecord;

    // 1. Write to atomic store (KV log) with 7-day TTL (钟墙)
    await this.deps.atomic.set(`authz:${id}`, record, null, AUTHZ_TTL_SEC);

    // 2. Write audit log entry
    await this.deps.logger.logSync({
      facility: AUTHZ_FACILITY,
      level: result.allowed ? LogLevel.INFO : LogLevel.WARN,
      message: result.allowed
        ? `Authorized ${params.actor} ${params.action} on ${params.resource}:${params.resourceId}`
        : `Denied ${params.actor} ${params.action} on ${params.resource}:${params.resourceId} — ${result.reason}`,
      metadata: {
        authzId: id,
        actor: params.actor,
        action: params.action,
        resource: params.resource,
        resourceId: params.resourceId,
        allowed: result.allowed,
        reason: result.reason,
      } satisfies Record<string, unknown>,
    });

    // 2b. KV audit record (7-day TTL, formatted line)
    await this.deps.audit?.write({
      level: result.allowed ? KernLevel.NOTICE : KernLevel.WARNING,
      facility: AUTHZ_FACILITY,
      message: result.allowed
        ? `Authorized ${params.actor} ${params.action} on ${params.resource}:${params.resourceId}`
        : `Denied ${params.actor} ${params.action} on ${params.resource}:${params.resourceId} — ${result.reason}`,
    });

    // 3. Update in-memory decision cache
    this.cache.set(this.#cacheKey(params), result.allowed);

    // 4. Append to recent-record buffer (trim oldest if over limit)
    this.recentRecords.addToTail(record);
    if (this.recentRecords.size > this.maxRecent) {
      this.recentRecords.removeFirst();
    }

    return id;
  }

  /**
   * Check the in-memory cache for a recent decision on the same params.
   * Returns the cached boolean, or `undefined` if no cached decision exists.
   */
  protected getCached(params: PermissionCheck): boolean | undefined {
    return this.cache.get(this.#cacheKey(params));
  }

  // ─── Cache management ───

  /** Clear the in-memory decision cache and recent-record buffer. */
  protected clearCache(): void {
    this.cache.clear();
    this.recentRecords.clear();
  }

  // ─── Convenience helpers for subclasses ───

  /**
   * Convenience: record an allow decision directly (bypasses DAG).
   * Useful for subclasses that override `check()` with short-circuit logic.
   */
  protected async allow(params: PermissionCheck, reason: string): Promise<PermissionResult> {
    const result: PermissionResult = { allowed: true, reason };
    await this.record(params, result);
    return result;
  }

  /**
   * Convenience: record a deny decision directly (bypasses DAG).
   * Useful for subclasses that override `check()` with short-circuit logic.
   */
  protected async deny(params: PermissionCheck, reason: string): Promise<PermissionResult> {
    const result: PermissionResult = { allowed: false, reason };
    await this.record(params, result);
    return result;
  }

  /**
   * Return recent authz records that match the given filter.
   * Only searches the in-memory buffer (most recent N records).
   */
  protected queryRecent(predicate: (r: AuthzRecord) => boolean): AuthzRecord[] {
    return [...this.recentRecords].filter(predicate);
  }

  // ─── Private ───

  #cacheKey(params: PermissionCheck): string {
    return `${params.actor}:${params.action}:${params.resource}:${params.resourceId}`;
  }
}
