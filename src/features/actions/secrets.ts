import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { SecretEncryption } from '../../core/auth/secret-encryption.ts';
import { AppError } from '../../core/types.ts';
import { generateVersionId } from '../../core/brand.ts';
import type { VersionId } from '../../core/brand.ts';

const PFX = 'action-secret:';
const IDX = 'action-secret:ids';

export interface WorkflowSecret {
  readonly id: string;
  readonly workflowId: string;
  readonly key: string;           // e.g. "DOCKER_PASSWORD"
  readonly encryptedValue: string; // AES-256-GCM ciphertext (or plaintext if no key configured)
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: VersionId;
}

export class WorkflowSecretService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly encryption?: SecretEncryption,
  ) {}

  async set(workflowId: string, key: string, value: string): Promise<WorkflowSecret> {
    const id = `ws_${crypto.randomUUID()}`;
    const now = Date.now();
    const encrypted = this.encryption
      ? await this.encryption.encrypt(value)
      : value;

    const secret: WorkflowSecret = {
      id, workflowId, key, encryptedValue: encrypted,
      createdAt: now, updatedAt: now, version: generateVersionId(),
    };

    // Upsert: if a secret with the same workflowId + key exists, replace it
    const existing = await this.#findByKey(workflowId, key);
    if (existing) {
      const updated: WorkflowSecret = { ...existing, encryptedValue: encrypted, updatedAt: now, version: generateVersionId() };
      await this.atomic.set(PFX + existing.id, updated, existing.version);
      return updated;
    }

    await this.atomic.set(PFX + id, secret, null);
    const idx = await this.atomic.get<string[]>(IDX);
    await this.atomic.set(IDX, [...(idx?.value ?? []), id], idx?.version ?? null);
    return secret;
  }

  async get(workflowId: string, key: string): Promise<string | null> {
    const secret = await this.#findByKey(workflowId, key);
    if (!secret) return null;
    return this.encryption
      ? this.encryption.decrypt(secret.encryptedValue)
      : secret.encryptedValue;
  }

  async list(workflowId: string): Promise<{ key: string; id: string }[]> {
    const idx = await this.atomic.get<string[]>(IDX);
    if (!idx) return [];
    const entries = await Promise.all(
      idx.value.map(i => this.atomic.get<WorkflowSecret>(PFX + i)),
    );
    return entries
      .filter(e => e?.value.workflowId === workflowId)
      .map(e => ({ key: e!.value.key, id: e!.value.id }));
  }

  async delete(id: string): Promise<void> {
    const entry = await this.atomic.get<WorkflowSecret>(PFX + id);
    if (!entry) throw new AppError(404, 'SECRET_NOT_FOUND', 'Secret not found');
    await this.atomic.set(PFX + id, null, entry.version);
    const idx = await this.atomic.get<string[]>(IDX);
    if (idx) await this.atomic.set(IDX, idx.value.filter(i => i !== id), idx.version);
  }

  /**
   * Resolve `${{ secrets.KEY }}` placeholders in a values object.
   */
  async resolveSecrets(
    workflowId: string,
    values: Record<string, string>,
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      result[k] = await this.#resolveValue(workflowId, v);
    }
    return result;
  }

  async #resolveValue(workflowId: string, value: string): Promise<string> {
    const pattern = /\$\{\{\s*secrets\.(\w+)\s*\}\}/g;
    let resolved = value;
    for (const match of value.matchAll(pattern)) {
      const key = match[1]!;
      const secretVal = await this.get(workflowId, key);
      if (secretVal === null) throw new AppError(400, 'SECRET_NOT_FOUND', `Secret "${key}" not found for workflow`);
      resolved = resolved.replace(match[0], secretVal);
    }
    return resolved;
  }

  async #findByKey(workflowId: string, key: string): Promise<WorkflowSecret | null> {
    const idx = await this.atomic.get<string[]>(IDX);
    if (!idx) return null;
    for (const id of idx.value) {
      const entry = await this.atomic.get<WorkflowSecret>(PFX + id);
      if (entry?.value.workflowId === workflowId && entry.value.key === key) {
        return entry.value;
      }
    }
    return null;
  }
}
