import type { IAtomicStore, IStoreTransaction } from '../../core/store/interfaces.ts';
import { TransactConflictError } from '../../core/store/interfaces.ts';

// ─── MAC (Mandatory Access Control) — immutable rules, never modifiable via API ───
const MAC_KEY = '_init:mac-policy';
import type { ILogWriter } from '../../core/audit/types.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { createFacility } from '../../core/brand.ts';
import { AppError } from '../../core/types.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';
import { applyUpdate } from '../../core/utils/apply-update.ts';
import type { AuditActor } from './audit.ts';
import { CrudStore, type PaginatedResult } from './crud-store.ts';
import type { Invitation, InviteStatus, CreateInviteInput } from './types.ts';
import { INVITE_PREFIX, INVITE_INDEX_KEY } from './types.ts';
import { setActivePolicy, DEFAULT_POLICY } from '../../core/audit/log-policy.ts';
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
  listPoliciesPaginated(page?: number, limit?: number, filter?: (item: StoredPolicy) => boolean): Promise<PaginatedResult<StoredPolicy>>;
  getPolicy(id: string): Promise<StoredPolicy | null>;
  updatePolicy(id: string, input: UpdatePolicyInput, actor?: AuditActor): Promise<StoredPolicy>;
  deletePolicy(id: string, actor?: AuditActor): Promise<void>;

  createUserGroup(input: CreateUserGroupInput, actor?: AuditActor): Promise<UserGroup>;
  listUserGroups(): Promise<UserGroup[]>;
  listUserGroupsPaginated(page?: number, limit?: number, filter?: (item: UserGroup) => boolean): Promise<PaginatedResult<UserGroup>>;
  getUserGroup(id: string): Promise<UserGroup | null>;
  updateUserGroup(id: string, input: UpdateUserGroupInput, actor?: AuditActor): Promise<UserGroup>;
  deleteUserGroup(id: string, actor?: AuditActor): Promise<void>;

  createPermGroup(input: CreatePermGroupInput, actor?: AuditActor): Promise<PermissionGroup>;
  listPermGroups(): Promise<PermissionGroup[]>;
  listPermGroupsPaginated(page?: number, limit?: number, filter?: (item: PermissionGroup) => boolean): Promise<PaginatedResult<PermissionGroup>>;
  getPermGroup(id: string): Promise<PermissionGroup | null>;
  updatePermGroup(id: string, input: UpdatePermGroupInput, actor?: AuditActor): Promise<PermissionGroup>;
  deletePermGroup(id: string, actor?: AuditActor): Promise<void>;
  createPermGroupFromTemplate(templateId: string, overrides: { name: string; description?: string | null | undefined; userGroupIds?: string[] | undefined; userIds?: string[] | undefined; }, actor?: AuditActor): Promise<PermissionGroup>;

  listTemplates(): Template[];
  getTemplate(id: string): Template | undefined;

  createRouteAcl(input: CreateRouteAclInput, actor?: AuditActor): Promise<RouteAcl>;
  listRouteAcls(): Promise<RouteAcl[]>;
  listRouteAclsPaginated(page?: number, limit?: number, filter?: (item: RouteAcl) => boolean): Promise<PaginatedResult<RouteAcl>>;
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
  listUserTplsPaginated(page?: number, limit?: number, filter?: (item: UserTemplate) => boolean): Promise<PaginatedResult<UserTemplate>>;
  getUserTpl(id: string): Promise<UserTemplate | null>;
  updateUserTpl(id: string, input: UpdateUserTplInput, actor?: AuditActor): Promise<UserTemplate>;
  deleteUserTpl(id: string, actor?: AuditActor): Promise<void>;

  check(input: PermissionCheckInput): Promise<PolicyMatchResult>;

  loadMacRules(): Promise<void>;
  seedMacRules(rules: PermissionRule[]): Promise<void>;

  grantTempElevation(userId: string, durationMs?: number): Promise<number>;
  revokeTempElevation(userId: string): Promise<void>;
  listTempElevations(): Promise<Array<{ userId: string; expiry: number }>>;

  // ── Invitations ──
  sendInvite(input: CreateInviteInput, invitedBy: string): Promise<Invitation>;
  acceptInvite(inviteId: string, userId: string): Promise<void>;
  rejectInvite(inviteId: string, userId: string): Promise<void>;
  listInvitations(userId: string): Promise<Invitation[]>;
}

export class PermissionService implements IPermissionService {
  private readonly userTplStore: CrudStore<UserTemplate>;
  readonly #policyMgr: PolicyManager;
  readonly #groupMgr: GroupManager;
  readonly #routeAclMgr: RouteAclManager;
  readonly #checker: PermissionChecker;
  #macRules: PermissionRule[] = [];

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
  async createPolicy(input: CreatePolicyInput, actor?: AuditActor) {
    const result = await this.#policyMgr.create(input, actor);
    this.#checker.invalidateCache();
    return result;
  }
  listPolicies() { return this.#policyMgr.list(); }
  listPoliciesPaginated(page?: number, limit?: number, filter?: (item: StoredPolicy) => boolean) { return this.#policyMgr.listPaginated(page, limit, filter); }
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
  async createUserGroup(input: CreateUserGroupInput, actor?: AuditActor) {
    const result = await this.#groupMgr.createUserGroup(input, actor);
    this.#checker.invalidateCache();
    return result;
  }
  listUserGroups() { return this.#groupMgr.listUserGroups(); }
  listUserGroupsPaginated(page?: number, limit?: number, filter?: (item: UserGroup) => boolean) { return this.#groupMgr.listUserGroupsPaginated(page, limit, filter); }
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
  async createPermGroup(input: CreatePermGroupInput, actor?: AuditActor) {
    const result = await this.#groupMgr.createPermGroup(input, actor);
    this.#checker.invalidateCache();
    return result;
  }
  listPermGroups() { return this.#groupMgr.listPermGroups(); }
  listPermGroupsPaginated(page?: number, limit?: number, filter?: (item: PermissionGroup) => boolean) { return this.#groupMgr.listPermGroupsPaginated(page, limit, filter); }
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
  listRouteAclsPaginated(page?: number, limit?: number, filter?: (item: RouteAcl) => boolean) { return this.#routeAclMgr.listPaginated(page, limit, filter); }
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
  listUserTplsPaginated(page?: number, limit?: number, filter?: (item: UserTemplate) => boolean) { return this.userTplStore.listPaginated(page, limit, filter); }
  getUserTpl(id: string) { return this.userTplStore.get(id); }

  async updateUserTpl(id: string, input: UpdateUserTplInput, actor?: AuditActor): Promise<UserTemplate> {
    const old = await this.userTplStore.get(id);
    if (!old) throw new AppError(404, 'USERTPL_NOT_FOUND', 'User template not found');
    const updated: UserTemplate = applyUpdate(old, {
      ...input,
      updatedAt: Date.now(),
    });
    await this.userTplStore.commitUpdate(id, updated);
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
    return this.#checker.check(input, this.#macRules);
  }

  // ── MAC Rules ──
  async loadMacRules(): Promise<void> {
    try {
      const entry = await this.atomic.get<PermissionRule[]>(MAC_KEY);
      if (entry) this.#macRules = entry.value ?? [];
    } catch { this.#macRules = []; }
  }

  async seedMacRules(rules: PermissionRule[]): Promise<void> {
    const existing = await this.atomic.get<PermissionRule[]>(MAC_KEY);
    if (existing) return;
    await this.atomic.set(MAC_KEY, rules, null);
    this.#macRules = rules;
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

  // ── Invitations ──

  async sendInvite(input: CreateInviteInput, invitedBy: string): Promise<Invitation> {
    const group = await this.#groupMgr.getUserGroup(input.groupId);
    if (!group) throw new AppError(404, 'GROUP_NOT_FOUND', 'User group not found');
    if (!group.adminIds.includes(invitedBy)) throw new AppError(403, 'FORBIDDEN', 'Only group admins can send invitations');

    const id = `inv_${crypto.randomUUID()}`;
    const invite: Invitation = {
      id, groupId: input.groupId, inviteeId: input.inviteeId,
      invitedBy, status: 'pending',
      createdAt: Date.now(), expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    };
    // Store invitation + update index
    await this.atomic.transact(async (txn) => {
      const idx = await txn.get<string[]>(INVITE_INDEX_KEY);
      txn.set(INVITE_INDEX_KEY, [...(idx ?? []), id]);
      txn.set(INVITE_PREFIX + id, invite);
    });
    this.audit?.write({
      level: KernLevel.INFO, facility: 'perm',
      message: `Invitation sent: ${invitedBy} invited ${input.inviteeId} to group ${input.groupId}`,
      metadata: { eventType: 'perm.invite.sent', inviteId: id, groupId: input.groupId, inviteeId: input.inviteeId },
    });
    return invite;
  }

  async acceptInvite(inviteId: string, userId: string): Promise<void> {
    const entry = await this.atomic.get<Invitation>(INVITE_PREFIX + inviteId);
    if (!entry) throw new AppError(404, 'INVITE_NOT_FOUND', 'Invitation not found');
    if (entry.value.inviteeId !== userId) throw new AppError(403, 'FORBIDDEN', 'Only the invitee can accept');
    if (entry.value.status !== 'pending') throw new AppError(409, 'ALREADY_PROCESSED', 'Invitation already processed');
    if (Date.now() > entry.value.expiresAt) throw new AppError(410, 'EXPIRED', 'Invitation has expired');

    // Update invitation status + add user to group
    await this.atomic.transact(async (txn) => {
      const inv = await txn.get<Invitation>(INVITE_PREFIX + inviteId);
      if (!inv || inv.status !== 'pending') throw new AppError(409, 'ALREADY_PROCESSED', 'Invitation already processed');
      txn.set(INVITE_PREFIX + inviteId, { ...inv, status: 'accepted' as InviteStatus });

      const grp = await txn.get<any>('usergroup:' + entry.value.groupId);
      if (grp) {
        const members = grp.memberIds ?? [];
        if (!members.includes(userId)) {
          txn.set('usergroup:' + entry.value.groupId, { ...grp, memberIds: [...members, userId], updatedAt: Date.now() });
        }
      }
    });
    this.audit?.write({
      level: KernLevel.INFO, facility: 'perm',
      message: `Invitation accepted: ${userId} joined group ${entry.value.groupId}`,
      metadata: { eventType: 'perm.invite.accepted', inviteId, groupId: entry.value.groupId, userId },
    });
  }

  async rejectInvite(inviteId: string, userId: string): Promise<void> {
    const entry = await this.atomic.get<Invitation>(INVITE_PREFIX + inviteId);
    if (!entry) throw new AppError(404, 'INVITE_NOT_FOUND', 'Invitation not found');
    if (entry.value.inviteeId !== userId) throw new AppError(403, 'FORBIDDEN', 'Only the invitee can reject');
    if (entry.value.status !== 'pending') throw new AppError(409, 'ALREADY_PROCESSED', 'Invitation already processed');

    await this.atomic.set(INVITE_PREFIX + inviteId, { ...entry.value, status: 'rejected' as InviteStatus }, entry.version);
  }

  async listInvitations(userId: string): Promise<Invitation[]> {
    const idx = await this.atomic.get<string[]>(INVITE_INDEX_KEY);
    if (!idx) return [];
    const entries = await Promise.all(idx.value.map(id => this.atomic.get<Invitation>(INVITE_PREFIX + id)));
    return entries
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .map(e => e.value)
      .filter(inv => inv.inviteeId === userId);
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
