/**
 * PodStore — OCC-guarded persistence for PodEntity.
 * Mirrors SandboxStore pattern.
 */

import type { IAtomicStore } from '../store/interfaces.ts';
import type { PodId, PodEntity, PodPhase } from './types.ts';
import { generateVersionId } from '../brand.ts';
import { AppError } from '../types.ts';
import type { VersionId } from '../brand.ts';

const KEY_PREFIX = 'pod:';
const INDEX_KEY = 'pod:ids';

function ver(v: string): VersionId { return v as VersionId; }

export class PodStore {
  constructor(private readonly atomic: IAtomicStore) {}

  async getById(podId: PodId): Promise<PodEntity | null> {
    const entry = await this.atomic.get<PodEntity>(`${KEY_PREFIX}${podId}`);
    return entry?.value ?? null;
  }

  async list(phase?: PodPhase, limit = 50, cursor?: string): Promise<{ items: PodEntity[]; nextCursor?: string }> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx?.value) return { items: [] };

    let ids = idx.value;
    const startIdx = cursor ? parseInt(cursor, 10) : 0;
    if (isNaN(startIdx) || startIdx >= ids.length) return { items: [] };
    ids = ids.slice(startIdx, startIdx + limit);

    const entries = await Promise.all(ids.map(id => this.atomic.get<PodEntity>(`${KEY_PREFIX}${id}`)));
    let items = entries.filter(e => e !== null).map(e => e!.value);
    if (phase) items = items.filter(p => p.phase === phase);

    const nextCursorVal = startIdx + limit < idx.value.length ? String(startIdx + limit) : undefined;
    return { items, ...(nextCursorVal !== undefined ? { nextCursor: nextCursorVal } : {}) };
  }

  async getAllIds(): Promise<string[]> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    return idx?.value ?? [];
  }

  async addToIndex(id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    await this.atomic.set(INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
  }

  async removeFromIndex(id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (idx) await this.atomic.set(INDEX_KEY, idx.value.filter(i => i !== id), idx.version);
  }

  /** Insert a new pod entity (expects OCC version null — first write). */
  async insert(entity: PodEntity): Promise<PodEntity | null> {
    const written = await this.atomic.set(`${KEY_PREFIX}${entity.podId}`, entity, null);
    return written ? entity : null;
  }

  /** OCC-guarded update. Returns updated entity or throws on conflict. */
  async update(podId: PodId, next: PodEntity, expectedVersion: string): Promise<PodEntity> {
    const newVersion = await this.atomic.set(`${KEY_PREFIX}${podId}`, next, ver(expectedVersion));
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    return next;
  }

  /** Perform an OCC-guarded phase transition. */
  async transition(podId: PodId, to: PodPhase): Promise<PodEntity> {
    const entry = await this.atomic.get<PodEntity>(`${KEY_PREFIX}${podId}`);
    if (!entry) throw new AppError(404, 'POD_NOT_FOUND', `Pod ${podId} not found`);

    const updated: PodEntity = {
      ...entry.value,
      phase: to,
      updatedAt: Date.now(),
      version: generateVersionId(),
    };

    return this.update(podId, updated, entry.value.version);
  }
}
