/**
 * Route ACL CRUD + checkRouteAccess — extracted from PermissionService
 */
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/audit/types.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';
import { AppError } from '../../core/types.ts';
import { applyUpdate } from '../../core/utils/apply-update.ts';
import { permLogAudit } from './audit.ts';
import type { AuditActor } from './audit.ts';
import { CrudStore } from './crud-store.ts';
import type { RouteAcl, CreateRouteAclInput, UpdateRouteAclInput } from './types.ts';
import { generateRouteAclId } from './types.ts';

function routeMatches(method: string, path: string, acl: RouteAcl): boolean {
  // Method matching: supports comma-separated list and wildcard
  if (acl.method !== '*') {
    const allowed = acl.method.split(',').map(s => s.trim());
    if (!allowed.includes(method) && !allowed.includes('*')) return false;
  }
  // Path matching
  if (!acl.pathPrefix || acl.pathPrefix === '*') return true;
  switch (acl.matchType) {
    case 'exact':
      return path === acl.pathPrefix;
    case 'regex':
      try { return new RegExp(acl.pathPrefix).test(path); }
      catch { return false; }
    default: // prefix
      return path.startsWith(acl.pathPrefix);
  }
}

export class RouteAclManager {
  private readonly store: CrudStore<RouteAcl>;
  private readonly atomic: IAtomicStore;
  /** Cache of sorted ACLs with store version for cross-instance coherency. */
  #cachedAclsVersion = -1;
  #cachedAcls: readonly RouteAcl[] | null = null;
  static readonly VERSION_KEY = 'routeacl:version';

  public constructor(
    _atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    private readonly audit?: IAuditWriter,
  ) {
    this.atomic = _atomic;
    this.store = new CrudStore<RouteAcl>(_atomic, 'routeacl:', 'routeacl:ids', 'ROUTEACL_NOT_FOUND');
  }

  /** Bump the global version so all RouteAclManager instances see the mutation. */
  public async #bumpVersion(): Promise<void> {
    this.#cachedAcls = null;
    const entry = await this.atomic.get<number>(RouteAclManager.VERSION_KEY);
    await this.atomic.set(RouteAclManager.VERSION_KEY, (entry?.value ?? 0) + 1, entry?.version ?? null);
  }

  public async create(input: CreateRouteAclInput, actor?: AuditActor): Promise<RouteAcl> {
    // Check for exact duplicates
    const existing = await this.store.list();
    const dup = existing.find(a =>
      a.method === input.method &&
      a.pathPrefix === input.pathPrefix &&
      a.matchType === input.matchType &&
      a.userId === input.userId &&
      a.userGroupId === input.userGroupId
    );
    if (dup) throw new AppError(409, 'ROUTEACL_DUPLICATE', `Route ACL already exists for ${input.method} ${input.pathPrefix}`);

    const id = generateRouteAclId();
    const acl: RouteAcl = {
      id, method: input.method, pathPrefix: input.pathPrefix,
      matchType: input.matchType, effect: input.effect,
      userId: input.userId, userGroupId: input.userGroupId,
      priority: input.priority ?? 1000,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    await this.store.insert(acl);
    await this.#bumpVersion();
    permLogAudit(this.logger, this.audit, 'perm.routeAcl.created', actor, { entityType: 'routeAcl', entityId: id, newValue: acl }, KernLevel.INFO);
    return acl;
  }

  public async list() { return this.store.list(); }
  public async listPaginated(page?: number, limit?: number, filter?: (item: RouteAcl) => boolean) { return this.store.listPaginated(page, limit, filter); }
  public async get(id: string) { return this.store.get(id); }

  public async update(id: string, input: UpdateRouteAclInput, actor?: AuditActor): Promise<RouteAcl> {
    const old = await this.store.get(id);
    if (!old) throw new AppError(404, 'ROUTEACL_NOT_FOUND', 'Route ACL not found');
    const updated: RouteAcl = applyUpdate(old, {
      ...input,
      updatedAt: Date.now(),
    });
    await this.store.commitUpdate(id, updated);
    await this.#bumpVersion();
    permLogAudit(this.logger, this.audit, 'perm.routeAcl.updated', actor, { entityType: 'routeAcl', entityId: id, changes: { old, new: updated } }, KernLevel.WARNING);
    return updated;
  }

  public async delete(id: string, actor?: AuditActor): Promise<void> {
    const old = await this.store.get(id);
    if (!old) throw new AppError(404, 'ROUTEACL_NOT_FOUND', 'Route ACL not found');
    await this.store.delete(id);
    await this.#bumpVersion();
    permLogAudit(this.logger, this.audit, 'perm.routeAcl.deleted', actor, { entityType: 'routeAcl', entityId: id, oldValue: old }, KernLevel.NOTICE);
  }

  /** Load ACLs, refreshing cache only when store version changes (cross-instance safe). */
  public async #loadCachedAcls(): Promise<readonly RouteAcl[]> {
    const verEntry = await this.atomic.get<number>(RouteAclManager.VERSION_KEY);
    const currentVersion = verEntry?.value ?? 0;
    if (this.#cachedAcls === null || this.#cachedAclsVersion !== currentVersion) {
      const raw = await this.store.list();
      this.#cachedAcls = [...raw].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      this.#cachedAclsVersion = currentVersion;
    }
    return this.#cachedAcls;
  }

  public async checkAccess(method: string, path: string, userId: string, userGroupIds: string[]): Promise<boolean> {
    const acls = await this.#loadCachedAcls();
    for (const acl of acls) {
      if (!routeMatches(method, path, acl)) continue;
      const matchesUser = !acl.userId || acl.userId === userId;
      const matchesGroup = !acl.userGroupId || userGroupIds.includes(acl.userGroupId);
      if (!matchesUser && !matchesGroup) continue;
      return acl.effect === 'allow';
    }
    return false;
  }
}
