import type { IAtomicStore } from '../store/interfaces.ts';
import { AppError } from '../types.ts';
import type { S3Policy, CreateS3PolicyInput, UpdateS3PolicyInput } from './types.ts';

const PREFIX = 's3-policy:';
const INDEX_KEY = 's3-policy:ids';

export class S3PolicyManager {
  constructor(private readonly atomic: IAtomicStore) {}

  async create(bucketId: string, input: CreateS3PolicyInput): Promise<S3Policy> {
    const id = `sp_${crypto.randomUUID()}`;
    const now = Date.now();
    const policy: S3Policy = {
      id,
      bucketId,
      name: input.name,
      description: input.description,
      effect: input.effect,
      actions: [...input.actions],
      pathPrefix: input.pathPrefix ?? '',
      applyToAutoKeys: input.applyToAutoKeys ?? true,
      priority: input.priority ?? 100,
      createdAt: now,
      updatedAt: now,
    };

    await this.atomic.set(PREFIX + id, policy, null);
    await this.#addToIndex(id);
    return policy;
  }

  async get(id: string): Promise<S3Policy | null> {
    const entry = await this.atomic.get<S3Policy>(PREFIX + id);
    return entry?.value ?? null;
  }

  async list(bucketId?: string): Promise<S3Policy[]> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx) return [];
    const entries = await Promise.all(idx.value.map(id => this.atomic.get<S3Policy>(PREFIX + id)));
    let policies = entries.filter(e => e).map(e => e!.value);
    if (bucketId) policies = policies.filter(p => p.bucketId === bucketId);
    return policies;
  }

  async update(id: string, input: UpdateS3PolicyInput): Promise<S3Policy> {
    const entry = await this.atomic.get<S3Policy>(PREFIX + id);
    if (!entry) throw new AppError(404, 'S3_POLICY_NOT_FOUND', 'S3 policy not found');

    const updated: S3Policy = {
      ...entry.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description ?? undefined } : {}),
      ...(input.effect !== undefined ? { effect: input.effect } : {}),
      ...(input.actions !== undefined ? { actions: [...input.actions] } : {}),
      ...(input.pathPrefix !== undefined ? { pathPrefix: input.pathPrefix } : {}),
      ...(input.applyToAutoKeys !== undefined ? { applyToAutoKeys: input.applyToAutoKeys } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      updatedAt: Date.now(),
    };

    const ver = await this.atomic.set(PREFIX + id, updated, entry.version);
    if (!ver) throw new AppError(409, 'CONFLICT', 'Concurrent modification');
    return updated;
  }

  async delete(id: string): Promise<void> {
    const entry = await this.atomic.get<S3Policy>(PREFIX + id);
    if (!entry) throw new AppError(404, 'S3_POLICY_NOT_FOUND', 'S3 policy not found');
    await this.atomic.set(PREFIX + id, null, entry.version);
    await this.#removeFromIndex(id);
  }

  /**
   * Resolve the effective policy for a bucket's auto-generated keys.
   * Collects all policies with applyToAutoKeys=true, sorts by priority (desc),
   * Deny overrides Allow.  Returns null when no policies exist (no restriction).
   */
  async resolve(bucketId: string): Promise<{ effect: 'Allow' | 'Deny'; actions: string[]; pathPrefix: string } | null> {
    const all = await this.list(bucketId);
    const autoPolicies = all.filter(p => p.applyToAutoKeys).sort((a, b) => b.priority - a.priority);

    if (autoPolicies.length === 0) return null;

    // Deny overrides: if any Deny matches, it wins
    const deny = autoPolicies.find(p => p.effect === 'Deny');
    if (deny) return { effect: 'Deny', actions: [...deny.actions], pathPrefix: deny.pathPrefix };

    // Otherwise use the highest-priority Allow
    const allow = autoPolicies[0]!;
    return { effect: 'Allow', actions: [...allow.actions], pathPrefix: allow.pathPrefix };
  }

  async #addToIndex(id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    await this.atomic.set(INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
  }

  async #removeFromIndex(id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx) return;
    await this.atomic.set(INDEX_KEY, idx.value.filter((i: string) => i !== id), idx.version);
  }
}
