/**
 * UserGroup + PermGroup CRUD — extracted from PermissionService
 */
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';
import { createFacility } from '../../core/brand.ts';
import { LogLevel, AppError } from '../../core/types.ts';
import { applyUpdate } from '../../core/utils/apply-update.ts';
import { permLogAudit } from './audit.ts';
import type { AuditActor } from './audit.ts';
import { CrudStore } from './crud-store.ts';
import type {
  UserGroup, CreateUserGroupInput, UpdateUserGroupInput,
  PermissionGroup, CreatePermGroupInput, UpdatePermGroupInput,
  Template,
} from './types.ts';
import { generateUserGroupId, generatePermGroupId } from './types.ts';

const FACILITY = createFacility('perm');

export class GroupManager {
  readonly ugStore: CrudStore<UserGroup>;
  readonly pgStore: CrudStore<PermissionGroup>;
  readonly templates: Template[];

  constructor(
    _atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    private readonly audit?: IAuditWriter,
    templates: Template[] = [],
  ) {
    this.ugStore = new CrudStore<UserGroup>(_atomic, 'usergroup:', 'usergroup:ids', 'USERGROUP_NOT_FOUND');
    this.pgStore = new CrudStore<PermissionGroup>(_atomic, 'permgroup:', 'permgroup:ids', 'PERMGROUP_NOT_FOUND');
    this.templates = templates;
  }

  // ── User Groups ──

  async createUserGroup(input: CreateUserGroupInput, actor?: AuditActor): Promise<UserGroup> {
    const id = generateUserGroupId();
    const memberIds = input.memberIds ?? [];
    const adminIds = input.adminIds ?? (actor?.userId ? [actor.userId] : []);
    const group: UserGroup = {
      id, name: input.name,
      description: input.description,
      memberIds,
      adminIds,
      dependsOn: input.dependsOn ?? [],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    await this.ugStore.insert(group);
    this.logger.logAsync({
      facility: FACILITY, level: LogLevel.INFO, message: 'User group created',
      metadata: { groupId: id, name: input.name, memberCount: input.memberIds?.length },
    });
    permLogAudit(this.logger, this.audit, 'perm.userGroup.created', actor, { entityType: 'userGroup', entityId: id, newValue: group }, KernLevel.INFO);
    return group;
  }

  async listUserGroups() { return this.ugStore.list(); }
  async listUserGroupsPaginated(page?: number, limit?: number, filter?: (item: UserGroup) => boolean) { return this.ugStore.listPaginated(page, limit, filter); }
  async getUserGroup(id: string) { return this.ugStore.get(id); }

  async updateUserGroup(id: string, input: UpdateUserGroupInput, actor?: AuditActor): Promise<UserGroup> {
    const old = await this.ugStore.get(id);
    if (!old) throw new AppError(404, 'USERGROUP_NOT_FOUND', 'User group not found');
    const updated: UserGroup = applyUpdate(old, {
      ...input,
      updatedAt: Date.now(),
    });
    await this.ugStore.commitUpdate(id, updated);
    permLogAudit(this.logger, this.audit, 'perm.userGroup.updated', actor, { entityType: 'userGroup', entityId: id, changes: { old, new: updated } }, KernLevel.WARNING);
    return updated;
  }

  async deleteUserGroup(id: string, actor?: AuditActor): Promise<void> {
    const old = await this.ugStore.get(id);
    if (!old) throw new AppError(404, 'USERGROUP_NOT_FOUND', 'User group not found');
    await this.ugStore.delete(id);
    permLogAudit(this.logger, this.audit, 'perm.userGroup.deleted', actor, { entityType: 'userGroup', entityId: id, oldValue: old }, KernLevel.NOTICE);
  }

  async getGroupByUserId(userId: string): Promise<UserGroup[]> {
    const all = await this.ugStore.list();
    return all.filter(g => g.memberIds.includes(userId));
  }

  // ── Permission Groups ──

  async createPermGroup(input: CreatePermGroupInput, actor?: AuditActor): Promise<PermissionGroup> {
    const id = generatePermGroupId();
    const group: PermissionGroup = {
      id, name: input.name,
      description: input.description,
      rules: input.rules,
      userGroupIds: input.userGroupIds ?? [],
      userIds: input.userIds ?? [],
      dependsOn: input.dependsOn ?? [],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    await this.pgStore.insert(group);
    this.logger.logAsync({
      facility: FACILITY, level: LogLevel.INFO, message: 'Permission group created',
      metadata: { groupId: id, name: input.name, ruleCount: input.rules.length },
    });
    permLogAudit(this.logger, this.audit, 'perm.permissionGroup.created', actor, { entityType: 'permissionGroup', entityId: id, newValue: group }, KernLevel.INFO);
    return group;
  }

  async listPermGroups() { return this.pgStore.list(); }
  async listPermGroupsPaginated(page?: number, limit?: number, filter?: (item: PermissionGroup) => boolean) { return this.pgStore.listPaginated(page, limit, filter); }
  async getPermGroup(id: string) { return this.pgStore.get(id); }

  async updatePermGroup(id: string, input: UpdatePermGroupInput, actor?: AuditActor): Promise<PermissionGroup> {
    const old = await this.pgStore.get(id);
    if (!old) throw new AppError(404, 'PERMGROUP_NOT_FOUND', 'Permission group not found');
    const updated: PermissionGroup = applyUpdate(old, {
      ...input,
      updatedAt: Date.now(),
    });
    await this.pgStore.commitUpdate(id, updated);
    permLogAudit(this.logger, this.audit, 'perm.permissionGroup.updated', actor, { entityType: 'permissionGroup', entityId: id, changes: { old, new: updated } }, KernLevel.WARNING);
    return updated;
  }

  async deletePermGroup(id: string, actor?: AuditActor): Promise<void> {
    const old = await this.pgStore.get(id);
    if (!old) throw new AppError(404, 'PERMGROUP_NOT_FOUND', 'Permission group not found');
    if (this.templates.some(t => t.id === old.name?.toLowerCase())) {
      throw new AppError(403, 'MAC_DENIED', `Cannot delete seed permission group "${old.name}" — protected by system policy`);
    }
    await this.pgStore.delete(id);
    permLogAudit(this.logger, this.audit, 'perm.permissionGroup.deleted', actor, { entityType: 'permissionGroup', entityId: id, oldValue: old }, KernLevel.NOTICE);
  }

  async createFromTemplate(templateId: string, overrides: {
    name: string; description?: string | null | undefined; userGroupIds?: string[] | undefined; userIds?: string[] | undefined;
  }, actor?: AuditActor): Promise<PermissionGroup> {
    const template = this.templates.find(t => t.id === templateId);
    if (!template) throw new AppError(404, 'TEMPLATE_NOT_FOUND', `Template "${templateId}" not found`);
    return this.createPermGroup({
      name: overrides.name,
      description: overrides.description ?? template.description,
      rules: template.rules,
      userGroupIds: overrides.userGroupIds ?? [],
      userIds: overrides.userIds ?? [],
    }, actor);
  }

  // ── Compare (reuses original logic) ──

  async comparePermGroups(idA: string, idB: string) {
    const a = await this.pgStore.get(idA);
    const b = await this.pgStore.get(idB);
    if (!a) throw new AppError(404, 'NOT_FOUND', `Permission group ${idA} not found`);
    if (!b) throw new AppError(404, 'NOT_FOUND', `Permission group ${idB} not found`);
    return buildCompareResult(a, b);
  }

  async compareUserGroups(idA: string, idB: string) {
    const a = await this.ugStore.get(idA);
    const b = await this.ugStore.get(idB);
    if (!a) throw new AppError(404, 'NOT_FOUND', `User group ${idA} not found`);
    if (!b) throw new AppError(404, 'NOT_FOUND', `User group ${idB} not found`);
    return buildCompareResult(a, b);
  }
}

function buildCompareResult(a: any, b: any) {
  const common: Record<string, unknown>[] = [];
  const onlyA: Record<string, unknown>[] = [];
  const onlyB: Record<string, unknown>[] = [];
  const depDiff = { onlyA: [] as string[], onlyB: [] as string[], common: [] as string[] };

  const aItems = a.rules ?? a.memberIds ?? [];
  const bItems = b.rules ?? b.memberIds ?? [];

  for (const aItem of aItems) {
    const aJson = JSON.stringify(aItem);
    const match = bItems.find((bItem: any) => JSON.stringify(bItem) === aJson);
    if (match) common.push(typeof aItem === 'string' ? { id: aItem } : aItem);
    else onlyA.push(typeof aItem === 'string' ? { id: aItem } : aItem);
  }
  for (const bItem of bItems) {
    const bJson = JSON.stringify(bItem);
    const inA = aItems.some((aItem: any) => JSON.stringify(aItem) === bJson);
    if (!inA) onlyB.push(typeof bItem === 'string' ? { id: bItem } : bItem);
  }

  if ((a.dependsOn ?? []).length > 0 || (b.dependsOn ?? []).length > 0) {
    depDiff.onlyA = (a.dependsOn ?? []).filter((d: string) => !(b.dependsOn ?? []).includes(d));
    depDiff.onlyB = (b.dependsOn ?? []).filter((d: string) => !(a.dependsOn ?? []).includes(d));
    depDiff.common = (a.dependsOn ?? []).filter((d: string) => (b.dependsOn ?? []).includes(d));
  }

  return { a: { id: a.id, name: a.name }, b: { id: b.id, name: b.name }, common, onlyA, onlyB, depDiff };
}
