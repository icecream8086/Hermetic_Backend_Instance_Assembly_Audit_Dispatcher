/**
 * Policy CRUD — extracted from PermissionService
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
import type { StoredPolicy, CreatePolicyInput, UpdatePolicyInput } from './types.ts';
import { createPolicyId } from './types.ts';

const FACILITY = createFacility('perm');

export class PolicyManager {
  private readonly store: CrudStore<StoredPolicy>;

  constructor(
    _atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    private readonly audit?: IAuditWriter,
  ) {
    this.store = new CrudStore<StoredPolicy>(_atomic, 'policy:', 'policy:ids', 'POLICY_NOT_FOUND');
  }

  async create(input: CreatePolicyInput, actor?: AuditActor): Promise<StoredPolicy> {
    const id = createPolicyId(crypto.randomUUID());
    const policy: StoredPolicy = {
      id, name: input.name,
      description: input.description,
      effect: input.effect,
      actions: input.actions ?? [],
      priority: input.priority ?? 0,
      enabled: true,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    await this.store.insert(policy);
    this.logger.logAsync({
      facility: FACILITY, level: LogLevel.INFO, message: 'Policy created',
      metadata: { policyId: id, name: input.name, effect: input.effect },
    });
    permLogAudit(this.logger, this.audit, 'perm.policy.created', actor, { entityType: 'policy', entityId: id, newValue: policy }, KernLevel.INFO);
    return policy;
  }

  async list(): Promise<StoredPolicy[]> { return this.store.list(); }
  async listPaginated(page?: number, limit?: number) { return this.store.listPaginated(page, limit); }
  async get(id: string): Promise<StoredPolicy | null> { return this.store.get(id); }

  async update(id: string, input: UpdatePolicyInput, actor?: AuditActor): Promise<StoredPolicy> {
    const old = await this.store.get(id);
    if (!old) throw new AppError(404, 'POLICY_NOT_FOUND', 'Policy not found');
    const updated: StoredPolicy = applyUpdate(old, {
      ...input,
      updatedAt: Date.now(),
    });
    await this.store.commitUpdate(id, updated, '');
    this.logger.logAsync({
      facility: FACILITY, level: LogLevel.INFO, message: 'Policy updated',
      metadata: { policyId: id, name: updated.name },
    });
    permLogAudit(this.logger, this.audit, 'perm.policy.updated', actor, { entityType: 'policy', entityId: id, changes: { old, new: updated } }, KernLevel.WARNING);
    return updated;
  }

  async delete(id: string, actor?: AuditActor): Promise<void> {
    const old = await this.store.get(id);
    await this.store.delete(id);
    permLogAudit(this.logger, this.audit, 'perm.policy.deleted', actor, { entityType: 'policy', entityId: id, oldValue: old }, KernLevel.NOTICE);
  }
}
