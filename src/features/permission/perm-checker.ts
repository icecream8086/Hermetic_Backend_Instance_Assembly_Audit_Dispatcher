/**
 * Permission evaluation logic — the heavy check() path extracted from PermissionService
 */
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { createFacility } from '../../core/brand.ts';
import { CrudStore } from './crud-store.ts';
import type {
  StoredPolicy, UserGroup, PermissionGroup, PermissionRule, PermissionCheckInput, PolicyMatchResult,
} from './types.ts';

const FACILITY = createFacility('perm');

const POLICY_PREFIX = 'policy:';
const POLICY_INDEX_KEY = 'policy:ids';
const USERGROUP_PREFIX = 'usergroup:';
const USERGROUP_INDEX_KEY = 'usergroup:ids';
const PERMGROUP_PREFIX = 'permgroup:';
const PERMGROUP_INDEX_KEY = 'permgroup:ids';

export class PermissionChecker {
  private readonly policyStore: CrudStore<StoredPolicy>;
  private readonly ugStore: CrudStore<UserGroup>;
  private readonly pgStore: CrudStore<PermissionGroup>;

  #cache: {
    policies: { ts: number; data: StoredPolicy[] } | null;
    userGroups: { ts: number; data: UserGroup[] } | null;
    permGroups: { ts: number; data: PermissionGroup[] } | null;
  } = { policies: null, userGroups: null, permGroups: null };
  readonly #CACHE_TTL = 5_000;

  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    _audit?: IAuditWriter,
  ) {
    this.policyStore = new CrudStore(atomic, POLICY_PREFIX, POLICY_INDEX_KEY, 'POLICY_NOT_FOUND');
    this.ugStore = new CrudStore(atomic, USERGROUP_PREFIX, USERGROUP_INDEX_KEY, 'USERGROUP_NOT_FOUND');
    this.pgStore = new CrudStore(atomic, PERMGROUP_PREFIX, PERMGROUP_INDEX_KEY, 'PERMGROUP_NOT_FOUND');
  }

  /** Invalidate the in-memory cache on any write through the parent service. */
  invalidateCache(): void {
    this.#cache = { policies: null, userGroups: null, permGroups: null };
  }

  async #cachedPolicyList(): Promise<StoredPolicy[]> {
    const now = Date.now();
    if (this.#cache.policies && now - this.#cache.policies.ts < this.#CACHE_TTL) return this.#cache.policies.data;
    const data = await this.policyStore.list();
    this.#cache.policies = { ts: now, data };
    return data;
  }

  async #cachedUserGroupList(): Promise<UserGroup[]> {
    const now = Date.now();
    if (this.#cache.userGroups && now - this.#cache.userGroups.ts < this.#CACHE_TTL) return this.#cache.userGroups.data;
    const data = await this.ugStore.list();
    this.#cache.userGroups = { ts: now, data };
    return data;
  }

  async #cachedPermGroupList(): Promise<PermissionGroup[]> {
    const now = Date.now();
    if (this.#cache.permGroups && now - this.#cache.permGroups.ts < this.#CACHE_TTL) return this.#cache.permGroups.data;
    const data = await this.pgStore.list();
    this.#cache.permGroups = { ts: now, data };
    return data;
  }

  /**
   * Main permission evaluation: user → groups → policies → rules → match.
   * Logic identical to the original PermissionService.check().
   */
  async check(input: PermissionCheckInput, _macRules: PermissionRule[]): Promise<PolicyMatchResult> {
    const { userId, action, resource, resourceOwnerId, ip } = input;
    const resourceId = resourceOwnerId;

    // 1) User must exist
    const userEntry = await this.atomic.get<any>('user:' + userId);
    if (!userEntry) return { allowed: false, reason: 'User not found' };

    // 2) Resolve user → userGroups → permGroups → rules
    const allUserGroups = await this.#cachedUserGroupList();
    const userGroupIds = allUserGroups.filter(g => g.memberIds?.includes(userId)).map(g => g.id);

    const allPermGroups = await this.#cachedPermGroupList();
    const matchedGroups = allPermGroups.filter(pg =>
      pg.userGroupIds?.some(ugId => userGroupIds.includes(ugId as any))
      || pg.userIds?.includes(userId)
    );
    const macRules = Array.isArray(_macRules) ? _macRules : [];
    const rules: Array<PermissionRule & { _source?: string }> = [
      ...macRules.map(r => ({ ...r, _source: 'MAC' })),
      ...matchedGroups.flatMap(pg => pg.rules.map(r => ({ ...r, _source: pg.name }))),
    ];

    // 3) Add global deny policies
    const policies = await this.#cachedPolicyList();
    for (const p of policies) {
      if (p.effect === 'deny' && p.actions) {
        rules.push({ effect: 'deny', actions: p.actions, resource: p.resource, priority: p.priority, _source: p.name });
      }
    }

    // 4) Evaluate by priority (highest first)
    const resourceTarget = resourceId ? `${resource}:${resourceId}` : resource;
    rules.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    for (const rule of rules) {
      if (!ruleMatches(rule, action, resourceTarget, ip)) continue;
      if (rule.effect !== 'allow') {
        this.logger.logAsync({
          facility: FACILITY, level: 0 as any,
          message: `Rule "${rule._source}" denied ${action} on ${resourceTarget}`,
          metadata: { eventType: 'perm.check', userId, action, resource, result: false, reason: rule._source, ip },
        });
      }
      return { allowed: rule.effect === 'allow', reason: `Matched rule from ${rule._source}` };
    }

    return { allowed: false, reason: 'No matching rule' };
  }
}

function ruleMatches(rule: PermissionRule, action: string, resourceTarget: string, _ip?: string): boolean {
  if (rule.actions && !matchPattern(rule.actions, action)) return false;
  if (rule.resource && !matchPattern(rule.resource, resourceTarget)) return false;
  return true;
}

function matchPattern(pattern: string | string[], target: string): boolean {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some(p => {
    if (p === '*') return true;
    if (p === target) return true;
    if (p.includes('*')) {
      const regex = new RegExp('^' + p.replace(/\*/g, '.*') + '$');
      return regex.test(target);
    }
    return false;
  });
}
