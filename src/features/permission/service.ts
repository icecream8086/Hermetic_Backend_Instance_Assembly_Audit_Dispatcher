import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { createFacility } from '../../core/brand.ts';
import { LogLevel, AppError } from '../../core/types.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';
import { createPolicyId } from '../../core/permission/types.ts';
import { permLogAudit } from './audit.ts';
import type { AuditActor } from './audit.ts';
import { CrudStore, type PaginatedResult } from './crud-store.ts';
import { setActivePolicy, DEFAULT_POLICY } from '../../core/logger/log-policy.ts';
import type {
  StoredPolicy,
  PolicyEffect,
  CreatePolicyInput,
  UpdatePolicyInput,
  PermissionCheckInput,
  PolicyMatchResult,
  UserGroup,
  CreateUserGroupInput,
  UpdateUserGroupInput,
  PermissionGroup,
  CreatePermGroupInput,
  UpdatePermGroupInput,
  PermissionRule,
  Template,
  RouteAcl,
  CreateRouteAclInput,
  UpdateRouteAclInput,
  UserTemplate,
  CreateUserTplInput,
  UpdateUserTplInput,
  CompareResult,
  LogPolicy,
} from './types.ts';
import { generatePermissionId, generateUserGroupId, generatePermGroupId, generateRouteAclId, generateUserTplId } from './types.ts';

const FACILITY = createFacility('perm');
const POLICY_PREFIX = 'policy:';
const POLICY_INDEX_KEY = 'policy:ids';
const USERGROUP_PREFIX = 'usergroup:';
const USERGROUP_INDEX_KEY = 'usergroup:ids';
const PERMGROUP_PREFIX = 'permgroup:';
const PERMGROUP_INDEX_KEY = 'permgroup:ids';
const ROUTEACL_PREFIX = 'routeacl:';
const ROUTEACL_INDEX_KEY = 'routeacl:ids';
const USERTPL_PREFIX = 'usertpl:';
const USERTPL_INDEX_KEY = 'usertpl:ids';
const LOG_POLICY_KEY = '_sys:log-policy';

function ipInCIDR(ip: string, cidr: string): boolean {
  const parts = cidr.split('/');
  const range = parts[0]!;
  const bits = parts[1] ?? '32';
  const mask = ~(2 ** (32 - parseInt(bits)) - 1) >>> 0;
  const ipInt = ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct), 0) >>> 0;
  const rangeInt = range.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct), 0) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

// ─── Diff helper (for audit changes) ───

function computeChanges(oldObj: Record<string, unknown>, newObj: Record<string, unknown>, skipKeys = new Set(['updatedAt'])) {
  const changes: Array<{ field: string; oldValue?: unknown; newValue?: unknown }> = [];
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
  for (const key of allKeys) {
    if (skipKeys.has(key)) continue;
    const oldVal = oldObj[key];
    const newVal = newObj[key] as unknown;
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push({ field: key, oldValue: oldVal, newValue: newVal });
    }
  }
  return changes;
}

// ─── Built-in templates ───

const TEMPLATES: Template[] = [
  {
    id: 'admin',
    name: 'Administrator',
    description: 'Full access to all resources',
    rules: [{ effect: 'allow', actions: ['*'], resource: '*', priority: 100 }],
  },
  {
    id: 'operator',
    name: 'Operator',
    description: 'CRUD access on sandboxes and users, no admin actions',
    rules: [
      { effect: 'allow', actions: ['create', 'read', 'update', 'delete'], priority: 80 },
      { effect: 'deny', actions: ['admin'], priority: 90 },
    ],
  },
  {
    id: 'viewer',
    name: 'Viewer',
    description: 'Read-only access to resources',
    rules: [{ effect: 'allow', actions: ['read'], priority: 70 }],
  },
  {
    id: 'login-only',
    name: 'Login Only',
    description: 'Can only authenticate, no resource access',
    rules: [
      { effect: 'allow', actions: ['login'], resource: 'session', priority: 60 },
      { effect: 'deny', actions: ['*'], resource: '*', priority: 50 },
    ],
  },
];

export interface IPermissionService {
  // Individual policies
  createPolicy(input: CreatePolicyInput, actor?: AuditActor): Promise<StoredPolicy>;
  listPolicies(): Promise<StoredPolicy[]>;
  listPoliciesPaginated(page?: number, limit?: number): Promise<PaginatedResult<StoredPolicy>>;
  getPolicy(id: string): Promise<StoredPolicy | null>;
  updatePolicy(id: string, input: UpdatePolicyInput, actor?: AuditActor): Promise<StoredPolicy>;
  deletePolicy(id: string, actor?: AuditActor): Promise<void>;


  // User groups
  createUserGroup(input: CreateUserGroupInput, actor?: AuditActor): Promise<UserGroup>;
  listUserGroups(): Promise<UserGroup[]>;
  listUserGroupsPaginated(page?: number, limit?: number): Promise<PaginatedResult<UserGroup>>;
  getUserGroup(id: string): Promise<UserGroup | null>;
  updateUserGroup(id: string, input: UpdateUserGroupInput, actor?: AuditActor): Promise<UserGroup>;
  deleteUserGroup(id: string, actor?: AuditActor): Promise<void>;

  // Permission groups
  createPermGroup(input: CreatePermGroupInput, actor?: AuditActor): Promise<PermissionGroup>;
  listPermGroups(): Promise<PermissionGroup[]>;
  listPermGroupsPaginated(page?: number, limit?: number): Promise<PaginatedResult<PermissionGroup>>;
  getPermGroup(id: string): Promise<PermissionGroup | null>;
  updatePermGroup(id: string, input: UpdatePermGroupInput, actor?: AuditActor): Promise<PermissionGroup>;
  deletePermGroup(id: string, actor?: AuditActor): Promise<void>;
  createPermGroupFromTemplate(templateId: string, overrides: {
    name: string; description?: string | null | undefined; userGroupIds?: string[] | undefined; userIds?: string[] | undefined;
  }, actor?: AuditActor): Promise<PermissionGroup>;

  // Templates (read-only — no audit needed for list/get)
  listTemplates(): Template[];
  getTemplate(id: string): Template | undefined;

  // Route ACL
  createRouteAcl(input: CreateRouteAclInput, actor?: AuditActor): Promise<RouteAcl>;
  listRouteAcls(): Promise<RouteAcl[]>;
  listRouteAclsPaginated(page?: number, limit?: number): Promise<PaginatedResult<RouteAcl>>;
  getRouteAcl(id: string): Promise<RouteAcl | null>;
  updateRouteAcl(id: string, input: UpdateRouteAclInput, actor?: AuditActor): Promise<RouteAcl>;
  deleteRouteAcl(id: string, actor?: AuditActor): Promise<void>;
  /** Check if a user (via their groups) has access to a route. */
  checkRouteAccess(method: string, path: string, userId: string): Promise<boolean>;

  // Compare
  comparePermGroups(idA: string, idB: string): Promise<CompareResult>;
  compareUserGroups(idA: string, idB: string): Promise<CompareResult>;

  // Log policy
  getLogPolicy(): Promise<LogPolicy & { readonly exists: boolean }>;
  updateLogPolicy(input: Partial<LogPolicy>, actor?: AuditActor): Promise<LogPolicy>;

  // User templates
  createUserTpl(input: CreateUserTplInput, actor?: AuditActor): Promise<UserTemplate>;
  listUserTpls(): Promise<UserTemplate[]>;
  listUserTplsPaginated(page?: number, limit?: number): Promise<PaginatedResult<UserTemplate>>;
  getUserTpl(id: string): Promise<UserTemplate | null>;
  updateUserTpl(id: string, input: UpdateUserTplInput, actor?: AuditActor): Promise<UserTemplate>;
  deleteUserTpl(id: string, actor?: AuditActor): Promise<void>;

  // Permission check
  check(input: PermissionCheckInput): Promise<PolicyMatchResult>;
}

export class PermissionService implements IPermissionService {
  private readonly policyStore: CrudStore<StoredPolicy>;
  private readonly ugStore: CrudStore<UserGroup>;
  private readonly pgStore: CrudStore<PermissionGroup>;
  private readonly routeAclStore: CrudStore<RouteAcl>;
  private readonly userTplStore: CrudStore<UserTemplate>;

  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    private readonly audit?: IAuditWriter,
  ) {
    this.policyStore = new CrudStore(atomic, POLICY_PREFIX, POLICY_INDEX_KEY, 'POLICY_NOT_FOUND');
    this.ugStore = new CrudStore(atomic, USERGROUP_PREFIX, USERGROUP_INDEX_KEY, 'USERGROUP_NOT_FOUND');
    this.pgStore = new CrudStore(atomic, PERMGROUP_PREFIX, PERMGROUP_INDEX_KEY, 'PERMGROUP_NOT_FOUND');
    this.routeAclStore = new CrudStore(atomic, ROUTEACL_PREFIX, ROUTEACL_INDEX_KEY, 'ROUTEACL_NOT_FOUND');
    this.userTplStore = new CrudStore(atomic, USERTPL_PREFIX, USERTPL_INDEX_KEY, 'USERTPL_NOT_FOUND');
  }

  // ═══════════════════════════════════════════
  // Individual policy CRUD (existing)
  // ═══════════════════════════════════════════

  async createPolicy(input: CreatePolicyInput, actor?: AuditActor): Promise<StoredPolicy> {
    const id = createPolicyId(generatePermissionId());
    const now = Date.now();
    const policy: StoredPolicy = {
      id, name: input.name, description: input.description,
      effect: input.effect, userId: input.userId, role: input.role,
      actions: input.actions ?? [], resource: input.resource,
      priority: input.priority ?? 0, enabled: true, createdAt: now, updatedAt: now,
    };
    await this.policyStore.insert(policy);
    await this.logger.logAsync({ facility: FACILITY, level: LogLevel.INFO, message: 'Policy created', metadata: { policyId: id, name: input.name, effect: input.effect } });
    permLogAudit(this.logger, this.audit, 'perm.policy.created', actor, { entityType: 'policy', entityId: id as string, newValue: policy }, KernLevel.NOTICE);
    return policy;
  }

  async listPolicies(): Promise<StoredPolicy[]> {
    return this.policyStore.list();
  }

  async listPoliciesPaginated(page = 1, limit = 50): Promise<PaginatedResult<StoredPolicy>> {
    return this.policyStore.listPaginated(page, limit);
  }

  async getPolicy(id: string): Promise<StoredPolicy | null> {
    return this.policyStore.get(id);
  }

  async deletePolicy(id: string, actor?: AuditActor): Promise<void> {
    const oldValue = await this.policyStore.delete(id);
    permLogAudit(this.logger, this.audit, 'perm.policy.deleted', actor, { entityType: 'policy', entityId: id, oldValue }, KernLevel.WARNING);
  }

  async updatePolicy(id: string, input: UpdatePolicyInput, actor?: AuditActor): Promise<StoredPolicy> {
    const entry = await this.atomic.get<StoredPolicy>(POLICY_PREFIX + id);
    if (!entry) throw new AppError(404, 'POLICY_NOT_FOUND', 'Policy not found');
    const updated: StoredPolicy = {
      ...entry.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.effect !== undefined ? { effect: input.effect as PolicyEffect } : {}),
      ...(input.userId !== undefined ? { userId: input.userId ?? undefined } : {}),
      ...(input.role !== undefined ? { role: input.role ?? undefined } : {}),
      ...(input.actions !== undefined ? { actions: input.actions } : {}),
      ...(input.resource !== undefined ? { resource: input.resource ?? undefined } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedAt: Date.now(),
    };
    const newVersion = await this.atomic.set(POLICY_PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    permLogAudit(this.logger, this.audit, 'perm.policy.updated', actor, {
      entityType: 'policy', entityId: id,
      changes: computeChanges(entry.value as unknown as Record<string, unknown>, updated as unknown as Record<string, unknown>),
    }, KernLevel.NOTICE);
    return updated;
  }



  // ═══════════════════════════════════════════
  // User group CRUD
  // ═══════════════════════════════════════════

  async createUserGroup(input: CreateUserGroupInput, actor?: AuditActor): Promise<UserGroup> {
    const id = generateUserGroupId();
    const now = Date.now();
    const group: UserGroup = {
      id, name: input.name, description: input.description,
      memberIds: input.memberIds ?? [], dependsOn: input.dependsOn ?? [],
      createdAt: now, updatedAt: now,
    };
    await this.ugStore.insert(group);
    await this.logger.logAsync({ facility: FACILITY, level: LogLevel.INFO, message: 'User group created', metadata: { groupId: id, name: input.name, memberCount: group.memberIds.length } });
    permLogAudit(this.logger, this.audit, 'perm.userGroup.created', actor, { entityType: 'userGroup', entityId: id as string, newValue: group }, KernLevel.NOTICE);
    return group;
  }

  async listUserGroups(): Promise<UserGroup[]> {
    return this.ugStore.list();
  }

  async listUserGroupsPaginated(page = 1, limit = 50): Promise<PaginatedResult<UserGroup>> {
    return this.ugStore.listPaginated(page, limit);
  }

  async getUserGroup(id: string): Promise<UserGroup | null> {
    return this.ugStore.get(id);
  }

  async updateUserGroup(id: string, input: UpdateUserGroupInput, actor?: AuditActor): Promise<UserGroup> {
    const entry = await this.atomic.get<UserGroup>(USERGROUP_PREFIX + id);
    if (!entry) throw new AppError(404, 'USERGROUP_NOT_FOUND', 'User group not found');
    const updated: UserGroup = {
      ...entry.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description ?? undefined } : {}),
      ...(input.memberIds !== undefined ? { memberIds: input.memberIds } : {}),
      ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn ?? [] } : {}),
      updatedAt: Date.now(),
    };
    const newVersion = await this.atomic.set(USERGROUP_PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    permLogAudit(this.logger, this.audit, 'perm.userGroup.updated', actor, { entityType: 'userGroup', entityId: id, changes: computeChanges(entry.value as unknown as Record<string, unknown>, updated as unknown as Record<string, unknown>) }, KernLevel.NOTICE);
    return updated;
  }

  async deleteUserGroup(id: string, actor?: AuditActor): Promise<void> {
    const oldValue = await this.ugStore.delete(id);
    permLogAudit(this.logger, this.audit, 'perm.userGroup.deleted', actor, { entityType: 'userGroup', entityId: id, oldValue }, KernLevel.WARNING);
  }

  // ═══════════════════════════════════════════
  // Permission group CRUD
  // ═══════════════════════════════════════════

  async createPermGroup(input: CreatePermGroupInput, actor?: AuditActor): Promise<PermissionGroup> {
    const id = generatePermGroupId();
    const now = Date.now();
    const group: PermissionGroup = {
      id, name: input.name, description: input.description,
      rules: input.rules,
      userGroupIds: input.userGroupIds ?? [],
      userIds: input.userIds ?? [],
      dependsOn: input.dependsOn ?? [],
      createdAt: now, updatedAt: now,
    };
    await this.pgStore.insert(group);
    await this.logger.logAsync({ facility: FACILITY, level: LogLevel.INFO, message: 'Permission group created', metadata: { groupId: id, name: input.name, ruleCount: group.rules.length } });
    permLogAudit(this.logger, this.audit, 'perm.permissionGroup.created', actor, { entityType: 'permissionGroup', entityId: id as string, newValue: group }, KernLevel.NOTICE);
    return group;
  }

  async listPermGroups(): Promise<PermissionGroup[]> {
    return this.pgStore.list();
  }

  async listPermGroupsPaginated(page = 1, limit = 50): Promise<PaginatedResult<PermissionGroup>> {
    return this.pgStore.listPaginated(page, limit);
  }

  async getPermGroup(id: string): Promise<PermissionGroup | null> {
    return this.pgStore.get(id);
  }

  async updatePermGroup(id: string, input: UpdatePermGroupInput, actor?: AuditActor): Promise<PermissionGroup> {
    const entry = await this.atomic.get<PermissionGroup>(PERMGROUP_PREFIX + id);
    if (!entry) throw new AppError(404, 'PERMGROUP_NOT_FOUND', 'Permission group not found');
    const updated: PermissionGroup = {
      ...entry.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description ?? undefined } : {}),
      ...(input.rules !== undefined ? { rules: input.rules } : {}),
      ...(input.userGroupIds !== undefined ? { userGroupIds: input.userGroupIds } : {}),
      ...(input.userIds !== undefined ? { userIds: input.userIds } : {}),
      ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn ?? [] } : {}),
      updatedAt: Date.now(),
    };
    const newVersion = await this.atomic.set(PERMGROUP_PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    permLogAudit(this.logger, this.audit, 'perm.permissionGroup.updated', actor, { entityType: 'permissionGroup', entityId: id, changes: computeChanges(entry.value as unknown as Record<string, unknown>, updated as unknown as Record<string, unknown>) }, KernLevel.NOTICE);
    return updated;
  }

  async deletePermGroup(id: string, actor?: AuditActor): Promise<void> {
    const oldValue = await this.pgStore.delete(id);
    permLogAudit(this.logger, this.audit, 'perm.permissionGroup.deleted', actor, { entityType: 'permissionGroup', entityId: id, oldValue }, KernLevel.WARNING);
  }

  async createPermGroupFromTemplate(templateId: string, overrides: {
    name: string; description?: string | null | undefined; userGroupIds?: string[] | undefined; userIds?: string[] | undefined;
  }, actor?: AuditActor): Promise<PermissionGroup> {
    const template = TEMPLATES.find(t => t.id === templateId);
    if (!template) throw new AppError(404, 'TEMPLATE_NOT_FOUND', `Template "${templateId}" not found`);
    return this.createPermGroup({
      name: overrides.name,
      description: overrides.description ?? template.description,
      rules: template.rules.map(r => ({ ...r })),
      userGroupIds: overrides.userGroupIds,
      userIds: overrides.userIds,
    }, actor);
  }

  // ═══════════════════════════════════════════
  // Templates
  // ═══════════════════════════════════════════

  listTemplates(): Template[] {
    return TEMPLATES;
  }

  getTemplate(id: string): Template | undefined {
    return TEMPLATES.find(t => t.id === id);
  }

  // ═══════════════════════════════════════════
  // UserTemplate CRUD
  // ═══════════════════════════════════════════

  async createUserTpl(input: CreateUserTplInput, _actor?: AuditActor): Promise<UserTemplate> {
    const id = generateUserTplId();
    const now = Date.now();
    const tpl: UserTemplate = {
      id, name: input.name, description: input.description,
      defaultGroupIds: input.defaultGroupIds ?? [],
      defaultPermGroupIds: input.defaultPermGroupIds ?? [],
      dependsOn: input.dependsOn ?? [],
      createdAt: now, updatedAt: now,
    };
    await this.userTplStore.insert(tpl);
    return tpl;
  }

  async listUserTpls(): Promise<UserTemplate[]> {
    return this.userTplStore.list();
  }

  async listUserTplsPaginated(page = 1, limit = 50): Promise<PaginatedResult<UserTemplate>> {
    return this.userTplStore.listPaginated(page, limit);
  }

  async getUserTpl(id: string): Promise<UserTemplate | null> {
    return this.userTplStore.get(id);
  }

  async updateUserTpl(id: string, input: UpdateUserTplInput, _actor?: AuditActor): Promise<UserTemplate> {
    const entry = await this.atomic.get<UserTemplate>(USERTPL_PREFIX + id);
    if (!entry) throw new AppError(404, 'USERTPL_NOT_FOUND', 'User template not found');
    const updated: UserTemplate = {
      ...entry.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description ?? undefined } : {}),
      ...(input.defaultGroupIds !== undefined ? { defaultGroupIds: input.defaultGroupIds } : {}),
      ...(input.defaultPermGroupIds !== undefined ? { defaultPermGroupIds: input.defaultPermGroupIds } : {}),
      ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn ?? [] } : {}),
      updatedAt: Date.now(),
    };
    const newVersion = await this.atomic.set(USERTPL_PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    return updated;
  }

  async deleteUserTpl(id: string, _actor?: AuditActor): Promise<void> {
    await this.userTplStore.delete(id);
  }

  // ═══════════════════════════════════════════
  // Route ACL CRUD
  // ═══════════════════════════════════════════

  async createRouteAcl(input: CreateRouteAclInput, actor?: AuditActor): Promise<RouteAcl> {
    const id = generateRouteAclId();
    const now = Date.now();
    const acl: RouteAcl = {
      id, method: input.method.toUpperCase(), pathPrefix: input.pathPrefix,
      matchType: input.matchType ?? 'prefix',
      effect: input.effect ?? 'allow',
      userId: input.userId, userGroupId: input.userGroupId,
      priority: input.priority ?? 0, createdAt: now, updatedAt: now,
    };
    await this.routeAclStore.insert(acl);
    permLogAudit(this.logger, this.audit, 'perm.routeAcl.created', actor, { entityType: 'routeAcl', entityId: id as string, newValue: acl }, KernLevel.NOTICE);
    return acl;
  }

  async listRouteAcls(): Promise<RouteAcl[]> {
    return this.routeAclStore.list();
  }

  async listRouteAclsPaginated(page = 1, limit = 50): Promise<PaginatedResult<RouteAcl>> {
    return this.routeAclStore.listPaginated(page, limit);
  }

  async getRouteAcl(id: string): Promise<RouteAcl | null> {
    return this.routeAclStore.get(id);
  }

  async updateRouteAcl(id: string, input: UpdateRouteAclInput, actor?: AuditActor): Promise<RouteAcl> {
    const entry = await this.atomic.get<RouteAcl>(ROUTEACL_PREFIX + id);
    if (!entry) throw new AppError(404, 'ROUTEACL_NOT_FOUND', 'Route ACL not found');
    const updated: RouteAcl = {
      ...entry.value,
      ...(input.method !== undefined ? { method: input.method.toUpperCase() } : {}),
      ...(input.pathPrefix !== undefined ? { pathPrefix: input.pathPrefix } : {}),
      ...(input.matchType !== undefined ? { matchType: input.matchType ?? 'prefix' } : {}),
      ...(input.effect !== undefined ? { effect: input.effect ?? 'allow' } : {}),
      ...(input.userId !== undefined ? { userId: input.userId ?? undefined } : {}),
      ...(input.userGroupId !== undefined ? { userGroupId: input.userGroupId ?? undefined } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      updatedAt: Date.now(),
    };
    const newVersion = await this.atomic.set(ROUTEACL_PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    permLogAudit(this.logger, this.audit, 'perm.routeAcl.updated', actor, { entityType: 'routeAcl', entityId: id, changes: computeChanges(entry.value as unknown as Record<string, unknown>, updated as unknown as Record<string, unknown>) }, KernLevel.NOTICE);
    return updated;
  }

  async deleteRouteAcl(id: string, actor?: AuditActor): Promise<void> {
    const oldValue = await this.routeAclStore.delete(id);
    permLogAudit(this.logger, this.audit, 'perm.routeAcl.deleted', actor, { entityType: 'routeAcl', entityId: id, oldValue }, KernLevel.WARNING);
  }

  /** Check if a user (via direct or group ACLs) has access to a route. */
  /** Resolve DAG: collect a node's transitive ancestors via dependsOn. */
  #resolveDag(nodes: Array<{ id: string; dependsOn?: string[] }>, seedIds: string[]): string[] {
    const visited = new Set<string>();
    const stack = [...seedIds];
    while (stack.length) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const node = nodes.find(n => n.id === id);
      if (node?.dependsOn) stack.push(...node.dependsOn);
    }
    return [...visited];
  }

  async checkRouteAccess(method: string, path: string, userId: string): Promise<boolean> {
    const [allAcls, allGroups] = await Promise.all([
      this.routeAclStore.list(),
      this.ugStore.list(),
    ]);

    // Find user's direct groups, then resolve DAG to get all inherited groups
    const directGroupIds = allGroups
      .filter(g => g.memberIds.includes(userId))
      .map(g => g.id);
    const userGroupIds = this.#resolveDag(allGroups, directGroupIds);

    // Dual-check: wheel group access requires Admin role (Linux sudo model)
    const wheelGroupIds = allGroups.filter(g => g.name === 'wheel').map(g => g.id);
    const isWheel = wheelGroupIds.some(wgId => userGroupIds.includes(wgId as any));
    let wheelElevated = false;
    if (isWheel) {
      const userEntry = await this.atomic.get<any>('user:' + userId);
      if (userEntry?.value?.role === 'root') wheelElevated = true;
    }

    // Sort ACLs by priority descending
    const sorted = allAcls.sort((a, b) => b.priority - a.priority);

    for (const acl of sorted) {
      if (acl.method !== '*' && acl.method !== method.toUpperCase()) continue;
      if (acl.matchType === 'exact' ? path !== acl.pathPrefix : !path.startsWith(acl.pathPrefix)) continue;
      if (acl.userId && acl.userId !== userId) continue;
      // If ACL targets a wheel group, user must have wheel elevation
      if (acl.userGroupId) {
        if (!userGroupIds.includes(acl.userGroupId as any)) continue;
        if (wheelGroupIds.includes(acl.userGroupId as any) && !wheelElevated) continue;
      }
      if (!acl.userId && !acl.userGroupId) continue;
      if (acl.effect === 'deny') return false;
      return true;
    }

    return false;
  }

  // ═══════════════════════════════════════════
  // Compare
  // ═══════════════════════════════════════════

  /** Build a CompareResult from two sets of items keyed by JSON. */
  #diffSets(aItems: Record<string, unknown>[], bItems: Record<string, unknown>[], keyFn: (x: Record<string, unknown>) => string): Pick<CompareResult, 'common' | 'onlyA' | 'onlyB'> {
    const aMap = new Map(aItems.map(x => [keyFn(x), x]));
    const bMap = new Map(bItems.map(x => [keyFn(x), x]));
    const common: Record<string, unknown>[] = [];
    const onlyA: Record<string, unknown>[] = [];
    const onlyB: Record<string, unknown>[] = [];
    for (const [k, v] of aMap) {
      if (bMap.has(k)) common.push(v); else onlyA.push(v);
    }
    for (const [k, v] of bMap) {
      if (!aMap.has(k)) onlyB.push(v);
    }
    return { common, onlyA, onlyB };
  }

  async comparePermGroups(idA: string, idB: string): Promise<CompareResult> {
    const allPerms = await this.pgStore.list();
    const a = allPerms.find(p => p.id === idA);
    const b = allPerms.find(p => p.id === idB);
    if (!a) throw new AppError(404, 'NOT_FOUND', `Permission group ${idA} not found`);
    if (!b) throw new AppError(404, 'NOT_FOUND', `Permission group ${idB} not found`);

    const depA = this.#resolveDag(allPerms, [idA]);
    const depB = this.#resolveDag(allPerms, [idB]);
    const depDiff = this.#diffSets(
      depA.map(id => ({ id })), depB.map(id => ({ id })), x => x.id as string,
    );

    const rulesA = a.rules.map(r => ({ ...r, _source: a.name }));
    const rulesB = b.rules.map(r => ({ ...r, _source: b.name }));
    const ruleDiff = this.#diffSets(rulesA, rulesB, x => `${x.effect}:${(x.actions as string[]).sort().join(',')}:${x.resource ?? '*'}:${x.priority}`);

    return {
      a: { id: a.id, name: a.name }, b: { id: b.id, name: b.name },
      common: ruleDiff.common, onlyA: ruleDiff.onlyA, onlyB: ruleDiff.onlyB,
      depDiff: { onlyA: depDiff.onlyA.map(x => x.id as string), onlyB: depDiff.onlyB.map(x => x.id as string), common: depDiff.common.map(x => x.id as string) },
    };
  }

  async compareUserGroups(idA: string, idB: string): Promise<CompareResult> {
    const allUgs = await this.ugStore.list();
    const a = allUgs.find(g => g.id === idA);
    const b = allUgs.find(g => g.id === idB);
    if (!a) throw new AppError(404, 'NOT_FOUND', `User group ${idA} not found`);
    if (!b) throw new AppError(404, 'NOT_FOUND', `User group ${idB} not found`);

    const depA = this.#resolveDag(allUgs, [idA]);
    const depB = this.#resolveDag(allUgs, [idB]);
    const depDiff = this.#diffSets(
      depA.map(id => ({ id })), depB.map(id => ({ id })), x => x.id as string,
    );

    const membersA = a.memberIds.map(id => ({ id }));
    const membersB = b.memberIds.map(id => ({ id }));
    const memberDiff = this.#diffSets(membersA, membersB, x => x.id as string);

    return {
      a: { id: a.id, name: a.name }, b: { id: b.id, name: b.name },
      common: memberDiff.common, onlyA: memberDiff.onlyA, onlyB: memberDiff.onlyB,
      depDiff: { onlyA: depDiff.onlyA.map(x => x.id as string), onlyB: depDiff.onlyB.map(x => x.id as string), common: depDiff.common.map(x => x.id as string) },
    };
  }

  // ═══════════════════════════════════════════
  // Log policy
  // ═══════════════════════════════════════════

  async getLogPolicy(): Promise<LogPolicy & { readonly exists: boolean }> {
    const entry = await this.atomic.get<LogPolicy>(LOG_POLICY_KEY);
    // GET has no side effects — does NOT call setActivePolicy()
    if (!entry) return { ...DEFAULT_POLICY, exists: false };
    return { ...entry.value, exists: true };
  }

  async updateLogPolicy(input: Partial<LogPolicy>, actor?: AuditActor): Promise<LogPolicy> {
    const existing = await this.atomic.get<LogPolicy>(LOG_POLICY_KEY);
    const updated: LogPolicy = {
      ...(existing?.value ?? DEFAULT_POLICY),
      ...input,
      updatedAt: Date.now(),
      updatedBy: actor?.userId,
    };
    await this.atomic.set(LOG_POLICY_KEY, updated, existing?.version ?? null);
    setActivePolicy(updated);
    return updated;
  }

  // ═══════════════════════════════════════════
  // Permission evaluation
  // ═══════════════════════════════════════════

  async check(input: PermissionCheckInput): Promise<PolicyMatchResult> {
    const { userId, action, resource, ip, timestamp } = input;
    const now = timestamp ?? Date.now();

    // 1. Load user
    const userEntry = await this.atomic.get<any>('user:' + userId);
    if (!userEntry) return { allowed: false, reason: 'User not found' };
    const user = userEntry.value;

    // 2. Evaluate user's loginPolicy (time + IP)
    const lp = user.loginPolicy;
    if (lp) {
      if (!lp.enabled && action === 'login') return { allowed: false, reason: 'Login disabled for this account' };
      if (lp.timeRanges?.length && action === 'login') {
        const d = new Date(now);
        const cur = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
        if (!lp.timeRanges.some((r: any) => cur >= r.start && cur <= r.end)) {
          return { allowed: false, reason: 'Login not allowed at this time' };
        }
      }
      if (lp.allowedCIDRs?.length && ip) {
        if (!lp.allowedCIDRs.some((c: string) => ipInCIDR(ip, c))) {
          return { allowed: false, reason: 'Login not allowed from this IP' };
        }
      }
    }

    const hasPublicKey = !!user.publicKeyEd25519;
    const userRole = user.role ?? '';

    // 3. Load all policies (individual + group)
    const [allPolicies, allUserGroups, allPermGroups] = await Promise.all([
      this.policyStore.list(),
      this.ugStore.list(),
      this.pgStore.list(),
    ]);

    // 3a. Find user's group IDs (resolve DAG)
    const directGroupIds = allUserGroups
      .filter(g => g.memberIds.includes(userId))
      .map(g => g.id);
    const userGroupIds = this.#resolveDag(allUserGroups, directGroupIds);

    // Dual-check: wheel group permission groups require Admin role
    const wheelGroupIds = allUserGroups.filter(g => g.name === 'wheel').map(g => g.id);
    const userIsElevated = wheelGroupIds.some(wgId => userGroupIds.includes(wgId as any))
      && userRole === 'root';

    // 3b. Collect rules from permission groups (resolve DAG for each matched group)
    const groupRules: Array<{ rule: PermissionRule; groupName: string }> = [];
    for (const pg of allPermGroups) {
      const applies = pg.userIds.includes(userId)
        || pg.userGroupIds.some(ugId => userGroupIds.includes(ugId as any));
      if (!applies) continue;
      // If this permission group targets a wheel group, skip if not elevated
      if (!userIsElevated && pg.userGroupIds.some(ugId => wheelGroupIds.includes(ugId as any))) continue;
      // Resolve this permission group's dependency chain
      const depIds = this.#resolveDag(allPermGroups, [pg.id]);
      for (const depId of depIds) {
        const dep = allPermGroups.find(p => p.id === depId);
        if (dep) {
          for (const rule of dep.rules) {
            groupRules.push({ rule, groupName: dep.name });
          }
        }
      }
    }

    // 3c. Filter individual policies
    const relevantPolicies = allPolicies
      .filter(p => p.enabled)
      .filter(p => {
        if (p.userId && p.userId !== userId) return false;
        if (p.role && p.role !== userRole) return false;
        return true;
      });

    // 4. Build evaluation list (rules from policies + rules from groups)
    interface EvalItem {
      effect: PolicyEffect;
      actions: string[];
      resource?: string | undefined;
      priority: number;
      name: string;
    }
    const evalItems: EvalItem[] = [
      ...relevantPolicies.map(p => ({
        effect: p.effect, actions: p.actions, resource: p.resource,
        priority: p.priority, name: p.name,
      })),
      ...groupRules.map(gr => ({
        effect: gr.rule.effect, actions: gr.rule.actions,
        resource: gr.rule.resource, priority: gr.rule.priority,
        name: gr.groupName + ' rule',
      })),
    ].filter(item => {
      if (!item.actions.length || item.actions.includes('*')) return true;
      return item.actions.includes(action);
    }).filter(item => {
      if (!item.resource || item.resource === '*') return true;
      return item.resource === resource;
    }).sort((a, b) => b.priority - a.priority);

    // 5. Evaluate (deny-overrides)
    for (const item of evalItems) {
      if (item.effect === 'deny') {
        return { allowed: false, reason: `Denied by policy: ${item.name}` };
      }
    }
    const firstAllow = evalItems.find(item => item.effect === 'allow');
    if (firstAllow) {
      return { allowed: true, reason: `Allowed by policy: ${firstAllow.name}` };
    }

    // 6. Default
    let result: PolicyMatchResult;
    if (action === 'no-password-login' && !hasPublicKey) {
      result = { allowed: false, reason: 'No public key configured for this account' };
    } else {
      result = { allowed: false, reason: 'No matching policy — denied by default' };
    }

    permLogAudit(this.logger, this.audit, 'perm.check', undefined, {
      userId, action, resource,
      result: result.allowed,
      reason: result.reason,
      ip: ip ?? null,
    }, result.allowed ? KernLevel.INFO : KernLevel.NOTICE);

    return result;
  }

  // ═══════════════════════════════════════════


}
