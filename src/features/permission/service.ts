import type { IAtomicStore, IStoreTransaction } from '../../core/store/interfaces.ts';
import { TransactConflictError } from '../../core/store/interfaces.ts';

// ─── MAC (Mandatory Access Control) — immutable rules, never modifiable via API ───
const MAC_KEY = '_init:mac-policy';
let _macRules: PermissionRule[] = [];
import type { ILogWriter } from '../../core/logger/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { createFacility } from '../../core/brand.ts';
import { AppError } from '../../core/types.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';
import { applyUpdate } from '../../core/utils/apply-update.ts';
import type { AuditActor } from './audit.ts';
import { CrudStore, type PaginatedResult } from './crud-store.ts';
import { setActivePolicy, DEFAULT_POLICY } from '../../core/logger/log-policy.ts';
import type {
  StoredPolicy, CreatePolicyInput, UpdatePolicyInput,
  PermissionCheckInput, PolicyMatchResult,
  UserGroup, CreateUserGroupInput, UpdateUserGroupInput,
  PermissionGroup, CreatePermGroupInput, UpdatePermGroupInput,
  PermissionRule, Template, RouteAcl, CreateRouteAclInput, UpdateRouteAclInput,
  UserTemplate, CreateUserTplInput, UpdateUserTplInput,
  CompareResult, LogPolicy,
} from './types.ts';
import { generateUserTplId } from './types.ts';
import { PolicyManager } from './policy-manager.ts';
import { GroupManager } from './group-manager.ts';
import { RouteAclManager } from './route-acl-manager.ts';
import { PermissionChecker } from './perm-checker.ts';

const FACILITY = createFacility('perm');
const USERTPL_PREFIX = 'usertpl:';
const USERTPL_INDEX_KEY = 'usertpl:ids';
const LOG_POLICY_KEY = '_sys:log-policy';

// ─── Built-in templates ───
const TEMPLATES: Template[] = [
  { id: 'admin', name: 'Administrator', description: 'Full access to all resources', rules: [{ effect: 'allow', actions: ['*'], resource: '*', priority: 100 }] },
  { id: 'operator', name: 'Operator', description: 'CRUD access on sandboxes and users, no admin actions', rules: [{ effect: 'allow', actions: ['create', 'read', 'update', 'delete'], priority: 80 }, { effect: 'deny', actions: ['admin'], priority: 90 }] },
  { id: 'viewer', name: 'Viewer', description: 'Read-only access to resources', rules: [{ effect: 'allow', actions: ['read'], priority: 70 }] },
  { id: 'login-only', name: 'Login Only', description: 'Can only authenticate, no resource access', rules: [{ effect: 'allow', actions: ['login'], resource: 'session', priority: 60 }, { effect: 'deny', actions: ['*'], resource: '*', priority: 50 }] },
  { id: 'daemon', name: 'Daemon Service Account', description: 'Key-only auth, sandbox CRUD on $self, no user management', rules: [
    { effect: 'allow', actions: ['login'], resource: 'session', priority: 60 },
    { effect: 'allow', actions: ['read', 'update'], resource: 'sandbox:$self', priority: 50 },
    { effect: 'allow', actions: ['read'], resource: 'image', priority: 50 },
    { effect: 'allow', actions: ['read'], resource: 'template', priority: 50 },
    { effect: 'deny', actions: ['admin', 'delete', 'create'], resource: 'user', priority: 99 },
    { effect: 'deny', actions: ['admin', 'create', 'update', 'delete'], resource: 'usergroup', priority: 99 },
    { effect: 'deny', actions: ['admin', 'create', 'update', 'delete'], resource: 'permgroup', priority: 99 },
    { effect: 'deny', actions: ['admin', 'create', 'update', 'delete'], resource: 'routeacl', priority: 99 },
  ]},
];

export interface IPermissionService {
  createPolicy(input: CreatePolicyInput, actor?: AuditActor): Promise<StoredPolicy>;
  listPolicies(): Promise<StoredPolicy[]>;
  listPoliciesPaginated(page?: number, limit?: number): Promise<PaginatedResult<StoredPolicy>>;
  getPolicy(id: string): Promise<StoredPolicy | null>;
  updatePolicy(id: string, input: UpdatePolicyInput, actor?: AuditActor): Promise<StoredPolicy>;
  deletePolicy(id: string, actor?: AuditActor): Promise<void>;

  createUserGroup(input: CreateUserGroupInput, actor?: AuditActor): Promise<UserGroup>;
  listUserGroups(): Promise<UserGroup[]>;
  listUserGroupsPaginated(page?: number, limit?: number): Promise<PaginatedResult<UserGroup>>;
  getUserGroup(id: string): Promise<UserGroup | null>;
  updateUserGroup(id: string, input: UpdateUserGroupInput, actor?: AuditActor): Promise<UserGroup>;
  deleteUserGroup(id: string, actor?: AuditActor): Promise<void>;

  createPermGroup(input: CreatePermGroupInput, actor?: AuditActor): Promise<PermissionGroup>;
  listPermGroups(): Promise<PermissionGroup[]>;
  listPermGroupsPaginated(page?: number, limit?: number): Promise<PaginatedResult<PermissionGroup>>;
  getPermGroup(id: string): Promise<PermissionGroup | null>;
  updatePermGroup(id: string, input: UpdatePermGroupInput, actor?: AuditActor): Promise<PermissionGroup>;
  deletePermGroup(id: string, actor?: AuditActor): Promise<void>;
  createPermGroupFromTemplate(templateId: string, overrides: { name: string; description?: string | null | undefined; userGroupIds?: string[] | undefined; userIds?: string[] | undefined; }, actor?: AuditActor): Promise<PermissionGroup>;

  listTemplates(): Template[];
  getTemplate(id: string): Template | undefined;

  createRouteAcl(input: CreateRouteAclInput, actor?: AuditActor): Promise<RouteAcl>;
  listRouteAcls(): Promise<RouteAcl[]>;
  listRouteAclsPaginated(page?: number, limit?: number): Promise<PaginatedResult<RouteAcl>>;
  getRouteAcl(id: string): Promise<RouteAcl | null>;
  updateRouteAcl(id: string, input: UpdateRouteAclInput, actor?: AuditActor): Promise<RouteAcl>;
  deleteRouteAcl(id: string, actor?: AuditActor): Promise<void>;
  checkRouteAccess(method: string, path: string, userId: string): Promise<boolean>;

  comparePermGroups(idA: string, idB: string): Promise<CompareResult>;
  compareUserGroups(idA: string, idB: string): Promise<CompareResult>;

  getLogPolicy(): Promise<LogPolicy & { readonly exists: boolean }>;
  updateLogPolicy(input: Partial<LogPolicy>, actor?: AuditActor): Promise<LogPolicy>;

  createUserTpl(input: CreateUserTplInput, actor?: AuditActor): Promise<UserTemplate>;
  listUserTpls(): Promise<UserTemplate[]>;
  listUserTplsPaginated(page?: number, limit?: number): Promise<PaginatedResult<UserTemplate>>;
  getUserTpl(id: string): Promise<UserTemplate | null>;
  updateUserTpl(id: string, input: UpdateUserTplInput, actor?: AuditActor): Promise<UserTemplate>;
  deleteUserTpl(id: string, actor?: AuditActor): Promise<void>;

  check(input: PermissionCheckInput): Promise<PolicyMatchResult>;

  loadMacRules(): Promise<void>;
  seedMacRules(rules: PermissionRule[]): Promise<void>;

  grantTempElevation(userId: string, durationMs?: number): Promise<number>;
  revokeTempElevation(userId: string): Promise<void>;
  listTempElevations(): Promise<Array<{ userId: string; expiry: number }>>;
}

export class PermissionService implements IPermissionService {
  private readonly userTplStore: CrudStore<UserTemplate>;
  readonly #policyMgr: PolicyManager;
  readonly #groupMgr: GroupManager;
  readonly #routeAclMgr: RouteAclManager;
  readonly #checker: PermissionChecker;

  constructor(
    private readonly atomic: IAtomicStore,
    _logger: ILogWriter,
    private readonly audit?: IAuditWriter,
  ) {
    this.#policyMgr = new PolicyManager(atomic, _logger, audit);
    this.#groupMgr = new GroupManager(atomic, _logger, audit, TEMPLATES);
    this.#routeAclMgr = new RouteAclManager(atomic, _logger, audit);
    this.#checker = new PermissionChecker(atomic, _logger, audit);
    this.userTplStore = new CrudStore<UserTemplate>(atomic, USERTPL_PREFIX, USERTPL_INDEX_KEY, 'USERTPL_NOT_FOUND');
    this.loadMacRules().catch(() => {});
  }

  // ── Policy CRUD ──
  createPolicy(input: CreatePolicyInput, actor?: AuditActor) { return this.#policyMgr.create(input, actor); }
  listPolicies() { return this.#policyMgr.list(); }
  listPoliciesPaginated(page?: number, limit?: number) { return this.#policyMgr.listPaginated(page, limit); }
  getPolicy(id: string) { return this.#policyMgr.get(id); }
  async updatePolicy(id: string, input: UpdatePolicyInput, actor?: AuditActor) {
    const result = await this.#policyMgr.update(id, input, actor);
    this.#checker.invalidateCache();
    return result;
  }
  async deletePolicy(id: string, actor?: AuditActor) {
    await this.#policyMgr.delete(id, actor);
    this.#checker.invalidateCache();
  }

  // ── User Groups ──
  createUserGroup(input: CreateUserGroupInput, actor?: AuditActor) { return this.#groupMgr.createUserGroup(input, actor); }
  listUserGroups() { return this.#groupMgr.listUserGroups(); }
  listUserGroupsPaginated(page?: number, limit?: number) { return this.#groupMgr.listUserGroupsPaginated(page, limit); }
  getUserGroup(id: string) { return this.#groupMgr.getUserGroup(id); }
  async updateUserGroup(id: string, input: UpdateUserGroupInput, actor?: AuditActor) {
    const result = await this.#groupMgr.updateUserGroup(id, input, actor);
    this.#checker.invalidateCache();
    return result;
  }
  async deleteUserGroup(id: string, actor?: AuditActor) {
    await this.#groupMgr.deleteUserGroup(id, actor);
    this.#checker.invalidateCache();
  }

  // ── Permission Groups ──
  createPermGroup(input: CreatePermGroupInput, actor?: AuditActor) { return this.#groupMgr.createPermGroup(input, actor); }
  listPermGroups() { return this.#groupMgr.listPermGroups(); }
  listPermGroupsPaginated(page?: number, limit?: number) { return this.#groupMgr.listPermGroupsPaginated(page, limit); }
  getPermGroup(id: string) { return this.#groupMgr.getPermGroup(id); }
  async updatePermGroup(id: string, input: UpdatePermGroupInput, actor?: AuditActor) {
    const result = await this.#groupMgr.updatePermGroup(id, input, actor);
    this.#checker.invalidateCache();
    return result;
  }
  async deletePermGroup(id: string, actor?: AuditActor) {
    await this.#groupMgr.deletePermGroup(id, actor);
    this.#checker.invalidateCache();
  }
  createPermGroupFromTemplate(templateId: string, overrides: any, actor?: AuditActor) {
    return this.#groupMgr.createFromTemplate(templateId, overrides, actor);
  }

  // ── Templates ──
  listTemplates(): Template[] { return TEMPLATES; }
  getTemplate(id: string): Template | undefined { return TEMPLATES.find(t => t.id === id); }

  // ── Route ACL ──
  createRouteAcl(input: CreateRouteAclInput, actor?: AuditActor) { return this.#routeAclMgr.create(input, actor); }
  listRouteAcls() { return this.#routeAclMgr.list(); }
  listRouteAclsPaginated(page?: number, limit?: number) { return this.#routeAclMgr.listPaginated(page, limit); }
  getRouteAcl(id: string) { return this.#routeAclMgr.get(id); }
  updateRouteAcl(id: string, input: UpdateRouteAclInput, actor?: AuditActor) { return this.#routeAclMgr.update(id, input, actor); }
  deleteRouteAcl(id: string, actor?: AuditActor) { return this.#routeAclMgr.delete(id, actor); }

  async checkRouteAccess(method: string, path: string, userId: string): Promise<boolean> {
    const userEntry = await this.atomic.get<any>('user:' + userId);
    if (!userEntry) return false;
    const allGroups = await this.#groupMgr.listUserGroups();
    const groupIds = allGroups.filter(g => g.memberIds?.includes(userId)).map(g => g.id);
    return this.#routeAclMgr.checkAccess(method, path, userId, groupIds);
  }

  // ── Compare ──
  comparePermGroups(idA: string, idB: string) { return this.#groupMgr.comparePermGroups(idA, idB); }
  compareUserGroups(idA: string, idB: string) { return this.#groupMgr.compareUserGroups(idA, idB); }

  // ── Log Policy ──
  async getLogPolicy(): Promise<LogPolicy & { readonly exists: boolean }> {
    const entry = await this.atomic.get<LogPolicy>(LOG_POLICY_KEY);
    if (!entry) return { ...DEFAULT_POLICY, exists: false };
    return { ...entry.value, exists: true };
  }

  async updateLogPolicy(input: Partial<LogPolicy>, actor?: AuditActor): Promise<LogPolicy> {
    const existing = await this.atomic.get<LogPolicy>(LOG_POLICY_KEY);
    const base = existing ? existing.value : DEFAULT_POLICY;
    const updated: LogPolicy = { ...base, ...input, updatedAt: Date.now() };
    await this.atomic.set(LOG_POLICY_KEY, updated, existing?.version ?? null);
    setActivePolicy(updated);
    this.audit?.write({
      level: KernLevel.WARNING, facility: FACILITY, message: 'Log policy updated',
      actorId: actor?.userId, metadata: { eventType: 'perm.logPolicy.updated', actorId: actor?.userId, changes: { old: base, new: updated } },
    });
    return updated;
  }

  // ── User Templates ──
  async createUserTpl(input: CreateUserTplInput, actor?: AuditActor): Promise<UserTemplate> {
    const id = generateUserTplId();
    const tpl: UserTemplate = {
      id, name: input.name,
      description: input.description,
      defaultGroupIds: input.defaultGroupIds ?? [],
      defaultPermGroupIds: input.defaultPermGroupIds ?? [],
      dependsOn: input.dependsOn ?? [],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    await this.userTplStore.insert(tpl);
    this.audit?.write({
      level: KernLevel.INFO, facility: FACILITY, message: `User template created — ${input.name}`,
      actorId: actor?.userId, metadata: { eventType: 'userTpl.created', templateId: id },
    });
    return tpl;
  }
  listUserTpls() { return this.userTplStore.list(); }
  listUserTplsPaginated(page?: number, limit?: number) { return this.userTplStore.listPaginated(page, limit); }
  getUserTpl(id: string) { return this.userTplStore.get(id); }

  async updateUserTpl(id: string, input: UpdateUserTplInput, actor?: AuditActor): Promise<UserTemplate> {
    const old = await this.userTplStore.get(id);
    if (!old) throw new AppError(404, 'USERTPL_NOT_FOUND', 'User template not found');
    const updated: UserTemplate = applyUpdate(old, {
      ...input,
      updatedAt: Date.now(),
    });
    await this.userTplStore.commitUpdate(id, updated, '');
    this.audit?.write({
      level: KernLevel.WARNING, facility: FACILITY, message: `User template updated — ${updated.name}`,
      actorId: actor?.userId, metadata: { eventType: 'userTpl.updated', templateId: id },
    });
    return updated;
  }

  async deleteUserTpl(id: string, actor?: AuditActor): Promise<void> {
    const old = await this.userTplStore.get(id);
    if (!old) throw new AppError(404, 'USERTPL_NOT_FOUND', 'User template not found');
    await this.userTplStore.delete(id);
    this.audit?.write({
      level: KernLevel.NOTICE, facility: FACILITY, message: `User template deleted — ${old.name}`,
      actorId: actor?.userId, metadata: { eventType: 'userTpl.deleted', templateId: id },
    });
  }

  // ── Permission Check ──
  check(input: PermissionCheckInput): Promise<PolicyMatchResult> {
    return this.#checker.check(input, _macRules);
  }

  // ── MAC Rules ──
  async loadMacRules(): Promise<void> {
    try {
      const entry = await this.atomic.get<PermissionRule[]>(MAC_KEY);
      if (entry) _macRules = entry.value ?? [];
    } catch { _macRules = []; }
  }

  async seedMacRules(rules: PermissionRule[]): Promise<void> {
    const existing = await this.atomic.get<PermissionRule[]>(MAC_KEY);
    if (existing) return;
    await this.atomic.set(MAC_KEY, rules, null);
    _macRules = rules;
  }

  // ── Temporary Elevation ──
  async grantTempElevation(userId: string, durationMs?: number): Promise<number> {
    const dur = durationMs ?? 30 * 60 * 1000;
    const expiry = Date.now() + dur;
    return this.#transactWithRetry(async (txn) => {
      const ids = await txn.get<string[]>('temp:elev:ids');
      const idList = ids ?? [];
      if (!idList.includes(userId)) idList.push(userId);
      txn.set('temp:elev:' + userId, { expiry });
      txn.set('temp:elev:ids', idList);
      return expiry;
    });
  }

  async revokeTempElevation(userId: string): Promise<void> {
    return this.#transactWithRetry(async (txn) => {
      const ids = await txn.get<string[]>('temp:elev:ids');
      const idList = ids ?? [];
      txn.set('temp:elev:ids', idList.filter((id: string) => id !== userId));
      txn.set('temp:elev:' + userId, { expiry: 0 });
    });
  }

  async listTempElevations(): Promise<Array<{ userId: string; expiry: number }>> {
    const idsEntry = await this.atomic.get<string[]>('temp:elev:ids');
    if (!idsEntry) return [];
    const ids = idsEntry.value;
    const result: Array<{ userId: string; expiry: number }> = [];
    const now = Date.now();
    const stale: string[] = [];
    for (const userId of ids) {
      const entry = await this.atomic.get<{ expiry: number }>('temp:elev:' + userId);
      if (entry && entry.value.expiry > now) {
        result.push({ userId, expiry: entry.value.expiry });
      } else {
        stale.push(userId);
      }
    }
    if (stale.length > 0) {
      await this.atomic.set('temp:elev:ids', ids.filter((id: string) => !stale.includes(id)), idsEntry.version);
    }
    return result;
  }

  async #transactWithRetry<T>(fn: (txn: IStoreTransaction) => Promise<T>, retries = 3): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try {
        return await this.atomic.transact(fn);
      } catch (e) {
        if (e instanceof TransactConflictError && i < retries - 1) continue;
        throw e;
      }
    }
    throw new AppError(409, 'CONFLICT', 'Transaction failed after retries');
  }
}
