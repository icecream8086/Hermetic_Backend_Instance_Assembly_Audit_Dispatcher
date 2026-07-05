/**
 * PodStore — OCC-guarded persistence for PodEntity.
 * Mirrors SandboxStore pattern.
 */

import type { IAtomicStore } from '../store/interfaces.ts';
import type { PodId, PodEntity, PodPhase } from './types.ts';
import type { VersionId } from '../brand.ts';
import { AppError } from '../types.ts';
const KEY_PREFIX = 'pod:';
const INDEX_KEY = 'pod:ids';

export class PodStore {
  public constructor(private readonly atomic: IAtomicStore) {}

  public async getById(podId: PodId): Promise<PodEntity | null> {
    const entry = await this.atomic.get<PodEntity>(`${KEY_PREFIX}${podId}`);
    if (!entry) return null;
    // Use the atomic store's OCC version, not the entity's stale .version field.
    // The entity's .version is set by createPod/transitionPod but the atomic
    // store independently generates metadata.v for CAS — they are NOT the same value.
    return { ...entry.value, version: entry.version };
  }

  public async list(phase?: PodPhase, limit = 50, cursor?: string): Promise<{ items: PodEntity[]; nextCursor?: string }> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx?.value) return { items: [] };

    let ids = idx.value;
    const startIdx = cursor ? parseInt(cursor, 10) : 0;
    if (isNaN(startIdx) || startIdx >= ids.length) return { items: [] };
    ids = ids.slice(startIdx, startIdx + limit);

    const entries = await Promise.all(ids.map(id => this.atomic.get<PodEntity>(`${KEY_PREFIX}${id}`)));
    let items: PodEntity[] = [];
    for (const e of entries) {
      if (e?.value) items.push(e.value);
    }
    if (phase) items = items.filter(p => p.phase === phase);

    const nextCursorVal = startIdx + limit < idx.value.length ? String(startIdx + limit) : undefined;
    return { items, ...(nextCursorVal !== undefined ? { nextCursor: nextCursorVal } : {}) };
  }

  public async getAllIds(): Promise<string[]> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    return idx?.value ?? [];
  }

  public async addToIndex(id: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const idx = await this.atomic.get<string[]>(INDEX_KEY);
      const ok = await this.atomic.set(INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
      if (ok) return;
    }
  }

  public async removeFromIndex(id: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const idx = await this.atomic.get<string[]>(INDEX_KEY);
      if (idx) {
        const ok = await this.atomic.set(INDEX_KEY, idx.value.filter(i => i !== id), idx.version);
        if (ok) return;
      }
    }
  }

  /** Insert a new pod entity (expects OCC version null — first write). */
  public async insert(entity: PodEntity): Promise<PodEntity | null> {
    const written = await this.atomic.set(`${KEY_PREFIX}${entity.podId}`, entity, null);
    return written ? entity : null;
  }

  /** OCC-guarded update. Returns updated entity or throws on conflict. */
  public async update(podId: PodId, next: PodEntity, expectedVersion: VersionId | null): Promise<PodEntity> {
    const newVersion = await this.atomic.set(`${KEY_PREFIX}${podId}`, next, expectedVersion);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    // Return entity with the atomic store's version so subsequent chained
    // updates (e.g. terminate → MarkFailed) pass the correct expectedVersion.
    return { ...next, version: newVersion };
  }
}
