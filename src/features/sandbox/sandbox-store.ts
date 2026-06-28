import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { SandboxId, Sandbox , SandboxStatus} from './types.ts';
import { isValidTransition } from './types.ts';
import { generateVersionId } from '../../core/brand.ts';
import { AppError } from '../../core/types.ts';
import { getValidated } from '../../core/store/validate.ts';
import { SandboxSchema } from './entity-schema.ts';

const KEY_PREFIX = 'sandbox:';
const INDEX_KEY = 'sandbox:ids';

/** Pure data access for sandbox entities — no provider logic. */
export class SandboxStore {
  constructor(private readonly atomic: IAtomicStore) {}

  async getById(id: SandboxId): Promise<Sandbox | null> {
    const validated = await getValidated(this.atomic, `${KEY_PREFIX}${id}`, SandboxSchema);
    return validated as unknown as Sandbox | null;
  }

  async list(status?: SandboxStatus, limit = 50, cursor?: string): Promise<{ items: Sandbox[]; nextCursor?: string }> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx) return { items: [] };

    let ids = idx.value;
    const startIdx = cursor ? parseInt(cursor, 10) : 0;
    if (isNaN(startIdx) || startIdx >= ids.length) return { items: [] };

    ids = ids.slice(startIdx, startIdx + limit);

    const entries = await Promise.all(
      ids.map(id => this.atomic.get<Sandbox>(`${KEY_PREFIX}${id}`)),
    );

    let items = entries.filter(e => e !== null).map(e => e.value);
    if (status) items = items.filter(s => s.status === status);

    const nextCursorVal = startIdx + limit < (idx?.value.length ?? 0)
      ? String(startIdx + limit)
      : undefined;

    return { items, ...(nextCursorVal !== undefined ? { nextCursor: nextCursorVal } : {}) };
  }

  async addToIndex(id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    await this.atomic.set(INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
  }

  async removeFromIndex(id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (idx) await this.atomic.set(INDEX_KEY, idx.value.filter((i: string) => i !== id), idx.version);
  }

  /** Perform an OCC-guarded status transition. Returns the updated sandbox. */
  async transition(id: SandboxId, to: SandboxStatus, _reason?: string, _actorId?: string): Promise<Sandbox> {
    const entry = await this.atomic.get<Sandbox>(`${KEY_PREFIX}${id}`);
    if (!entry) throw new AppError(404, 'SANDBOX_NOT_FOUND', `Sandbox ${id} not found`);

    const from = entry.value;
    if (!isValidTransition(from.status, to)) {
      throw new AppError(409, 'INVALID_TRANSITION', `Cannot transition from ${from.status} to ${to}`);
    }

    const updated: Sandbox = {
      ...from,
      status: to,
      updatedAt: Date.now(),
      version: generateVersionId(),
    };

    const newVersion = await this.atomic.set(`${KEY_PREFIX}${id}`, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');

    return updated;
  }
}
