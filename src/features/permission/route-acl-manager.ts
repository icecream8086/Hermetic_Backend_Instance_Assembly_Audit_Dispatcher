/**
 * Route ACL CRUD + checkRouteAccess — extracted from PermissionService
 */
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
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
  if (acl.method !== '*' && acl.method !== method) return false;
  if (!acl.pathPrefix || acl.pathPrefix === '*') return true;
  if (acl.matchType === 'exact') return path === acl.pathPrefix;
  return path.startsWith(acl.pathPrefix);
}

export class RouteAclManager {
  private readonly store: CrudStore<RouteAcl>;

  constructor(
    _atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    private readonly audit?: IAuditWriter,
  ) {
    this.store = new CrudStore<RouteAcl>(_atomic, 'routeacl:', 'routeacl:ids', 'ROUTEACL_NOT_FOUND');
  }

  async create(input: CreateRouteAclInput, actor?: AuditActor): Promise<RouteAcl> {
    const id = generateRouteAclId();
    const acl: RouteAcl = {
      id, method: input.method, pathPrefix: input.pathPrefix,
      matchType: input.matchType, effect: input.effect,
      userId: input.userId, userGroupId: input.userGroupId,
      priority: input.priority ?? 1000,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    await this.store.insert(acl);
    permLogAudit(this.logger, this.audit, 'perm.routeAcl.created', actor, { entityType: 'routeAcl', entityId: id, newValue: acl }, KernLevel.INFO);
    return acl;
  }

  async list() { return this.store.list(); }
  async listPaginated(page?: number, limit?: number) { return this.store.listPaginated(page, limit); }
  async get(id: string) { return this.store.get(id); }

  async update(id: string, input: UpdateRouteAclInput, actor?: AuditActor): Promise<RouteAcl> {
    const old = await this.store.get(id);
    if (!old) throw new AppError(404, 'ROUTEACL_NOT_FOUND', 'Route ACL not found');
    const updated: RouteAcl = applyUpdate(old, {
      ...input,
      updatedAt: Date.now(),
    });
    await this.store.commitUpdate(id, updated, '');
    permLogAudit(this.logger, this.audit, 'perm.routeAcl.updated', actor, { entityType: 'routeAcl', entityId: id, changes: { old, new: updated } }, KernLevel.WARNING);
    return updated;
  }

  async delete(id: string, actor?: AuditActor): Promise<void> {
    const old = await this.store.get(id);
    if (!old) throw new AppError(404, 'ROUTEACL_NOT_FOUND', 'Route ACL not found');
    await this.store.delete(id);
    permLogAudit(this.logger, this.audit, 'perm.routeAcl.deleted', actor, { entityType: 'routeAcl', entityId: id, oldValue: old }, KernLevel.NOTICE);
  }

  async checkAccess(method: string, path: string, userId: string, userGroupIds: string[]): Promise<boolean> {
    const acls = await this.store.list();
    // deny rules evaluated first (default-deny on match)
    for (const acl of acls.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))) {
      if (!routeMatches(method, path, acl)) continue;
      const matchesUser = !acl.userId || acl.userId === userId;
      const matchesGroup = !acl.userGroupId || userGroupIds.includes(acl.userGroupId);
      if (!matchesUser && !matchesGroup) continue;
      return acl.effect === 'allow';
    }
    return false;
  }
}
